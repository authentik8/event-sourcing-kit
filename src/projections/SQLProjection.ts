import debugModule from 'debug';
import { inject, injectable } from 'inversify';
import Knex, { QueryInterface } from 'knex';

import { IAggregateEvent, IEventStore } from '../interfaces';

import { FRAMEWORK_TYPES } from '../constants';
import { eventEmitterAsyncIterator } from '../util';
import {
  IProjection,
  IProjectionPositionStore,
  ISQLProjectionEventHandlerMap,
  ITableDefinition
} from './interfaces';
import { buildTable } from './util';

const debug = debugModule('eskit:projections:SQLProjection');
const BEGINNING = 0;

/**
 * Abstract class for the definition of projections backed by SQL storage
 */
@injectable()
abstract class SQLProjection implements IProjection {
  // Definition of the table schema associated with this projection
  protected abstract schema: ITableDefinition;

  // Map of event types to the corresponding database operations that should be performed
  protected abstract eventHandlers: ISQLProjectionEventHandlerMap;

  // Base query interface for the projection's SQL table
  private _collection?: QueryInterface;

  // Public getter for the projection's SQL table, producing a new instance each time
  protected get collection(): QueryInterface {
    return this._collection!.clone();
  }

  // Store the `knex` instance used to connect to the database
  private _knex: Knex;

  // Event store
  private _store: IEventStore;

  // Current position (i.e. last known event) of this projection
  private _position?: number;

  // Storage for current position
  private _positionStore: IProjectionPositionStore;

  // Boolean flag indicating whether this projection has been started
  private _started: boolean = false;

  constructor(
    @inject(FRAMEWORK_TYPES.projections.KnexClient) knex: Knex,
    @inject(FRAMEWORK_TYPES.eventstore.EventStore) store: IEventStore,
    @inject(FRAMEWORK_TYPES.projections.ProjectionPositionStore)
    positionStore: IProjectionPositionStore
  ) {
    this._knex = knex;
    this._store = store;
    this._positionStore = positionStore;
    this.start = this.start.bind(this);
    this.apply = this.apply.bind(this);
    this.rebuild = this.rebuild.bind(this);
    this.getSavedPosition = this.getSavedPosition.bind(this);
    this.updateSavedPosition = this.updateSavedPosition.bind(this);
    this._ensureTable = this._ensureTable.bind(this);
    this._applyEventsSince = this._applyEventsSince.bind(this);
    this._bindEventStream = this._bindEventStream.bind(this);
  }

  /**
   * Start the projection:
   */
  public async start(): Promise<void> {
    this._started = true;

    // Connect event handler
    // For as long as we don't call "next", this will buffer events while reconstituting projection state
    const eventStream = eventEmitterAsyncIterator<IAggregateEvent>(
      this._store,
      'saved',
      {
        immediateSubscribe: true
      }
    );
    debug(`Created generator from event emitter: ${eventStream}`);

    // Initialise SQL storage
    await this._ensureTable(this._knex);

    // Load the last known event for this projection
    this._position = await this.getSavedPosition();

    // Apply all events that have been saved to the store since the last event known to this projection
    try {
      await this._applyEventsSince(this._position);
    } catch (e) {
      const reason = new Error('Failed to start projection.');
      reason.stack += '`\n Caused By:\n' + e.stack;
      throw reason;
    }

    this._bindEventStream(eventStream);
  }

  // Promise that will resolve once the projection is up to date
  public async ready(): Promise<void> {
    if (!this._started) {
      return this.start();
    }
    return Promise.resolve();
  }

  /**
   * Applies an event to the projection
   * @param event New event to process
   * @returns Promise that resolves once projection has been updated
   */
  public async apply(event: IAggregateEvent): Promise<void> {
    const eventType = `${event.aggregate.name}.${event.name}`.toLowerCase();

    debug(`Apply event ${eventType}: ${JSON.stringify(event)}`);

    const handler = this.eventHandlers[eventType];

    if (handler !== undefined) {
      // If this projection cares about the event, apply the handler
      try {
        await handler(this.collection!, event);
      } catch (e) {
        const reason = new Error(
          `Failed to apply event ${eventType} to projection`
        );
        reason.stack += `\nCaused by:\n` + e.stack;
        throw reason;
      }
    } else {
      debug(`Unable to find handler for ${eventType}`);
    }

    // Update the last known position of this projection
    await this.updateSavedPosition(event.id);
  }

  /**
   * Rebuilds the projection's state by dropping the table & replaying all events
   * @returns Promsie that resolves once the projection has been rebuilt
   */
  public async rebuild(): Promise<void> {
    // Drop the projection table if it exists
    await this._knex.schema.dropTableIfExists(this.schema.name);
    debug(`Dropped table "${this.schema.name}"`);

    // Reset our saved position to 0
    await this.updateSavedPosition(BEGINNING);
    debug(`Reset projection position to ${BEGINNING}`);

    // Restart the projection
    await this.start();
    debug('Started projection');
  }

  /**
   * Load the last known position of this projection
   */
  protected async getSavedPosition(): Promise<number> {
    if (this._position === undefined) {
      this._position = await this._positionStore.load(this.schema.name);
    }
    return Promise.resolve(this._position);
  }

  protected async updateSavedPosition(position: number): Promise<void> {
    this._position = position;
    try {
      await this._positionStore.update(this.schema.name, position);
    } catch (e) {
      const reason = new Error(`Failed to update SQL Projection position.`);
      reason.stack += '\nCaused By:\n' + e.stack;
      throw reason;
    }
  }

  /**
   * Ensures that the table associated with this projection exists
   * @param db Knex client
   */
  private async _ensureTable(db: Knex) {
    const tableName = this.schema.name;

    // TODO: Check that the schema matches the definition
    const exists = await db.schema.hasTable(tableName);

    if (!exists) {
      // Create the table if it doesn't already exist
      await db.schema.createTable(tableName, buildTable(this.schema));
    }

    // Set the collection attribute on the projection
    this._collection = db(tableName);
  }

  /**
   * Process all events from the event store saved after a given point in the stream
   * @param position Position to load events from the store since
   * @returns Promise that resolves once all events have been applied
   */
  private async _applyEventsSince(position: number): Promise<void> {
    debug(`Retrieving events since event #${position}`);
    const unprocessedEvents = await this._store.loadAllEvents(position);
    debug(`Applying ${unprocessedEvents.length} events`);
    for (const event of unprocessedEvents) {
      try {
        await this.apply(event);
      } catch (e) {
        const reason = new Error(`Failed to apply event stream.`);
        reason.stack += `\nCaused By:\n` + e.stack;
        throw reason;
      }
    }
  }

  private async _bindEventStream(
    eventStream: AsyncIterableIterator<IAggregateEvent>
  ) {
    // Connect the `apply` method to the stream of events produced by the event store
    debug('Binding to event stream');
    for await (const event of eventStream) {
      debug(`Received event from stream: ${event}`);
      await this.apply(event);
    }
  }
}

export default SQLProjection;
