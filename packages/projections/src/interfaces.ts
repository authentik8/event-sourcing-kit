import { IAggregateEvent } from '@eskit/core';
import { QueryInterface } from 'knex';

export type ColumnType =
  | 'text'
  | 'integer'
  | 'increments'
  | 'boolean'
  | 'bigInteger'
  | 'string'
  | 'float'
  | 'decimal'
  | 'date'
  | 'dateTime'
  | 'time'
  | 'timestamp'
  | 'binary'
  | 'enum'
  | 'json'
  | 'jsonb'
  | 'uuid';

export interface IColumnDefinition {
  type: ColumnType;
  opts?: any[];
}

export interface IIndexDefinition {
  columns: string[];
  name?: string;
  type?: string;
}

export interface IUniqueConstraint {
  columns: string[];
  name?: string;
}

export interface ITableDefinition {
  columns: { [name: string]: ColumnType | IColumnDefinition };
  indexes?: IIndexDefinition[];
  name: string;
  primaryKey?: string[];
  uniqueConstraints?: IUniqueConstraint[];
}

/**
 * Object mapping an event's full name to the operations required to update the backing SQL table
 */
export interface ISQLProjectionEventHandlerMap {
  [eventName: string]: (
    collection: QueryInterface,
    event: IAggregateEvent
  ) => Promise<void>;
}

export interface IProjection {
  /**
   * Start the projection:
   * - Bind to the event log's "saved" event dispatcher
   * - Buffer all events received for the time being
   * - Load the last event known to this projection
   * - Retrieve all events saved to the log since then
   * - Replay all buffered events
   * - Connect the event log's "saved" event disaptcher straight to the `apply` method
   */
  start(): Promise<void>;

  /**
   * Apply an event to the projection state
   * @param event Event to update the projection with
   */
  apply(event: IAggregateEvent): Promise<void>;

  /**
   * Discard the saved projection state & rebuild by replaying all events
   */
  rebuild(): Promise<void>;
}

/**
 * Storage mechanism for recording the current position of a projection
 */
export interface IProjectionPositionStore {
  /**
   * Load the saved position of a projection
   * @param identifier Projection identifier
   */
  load(identifier: string): Promise<number>;

  /**
   * Save the last known position of a projection
   * @param identifier Projection identifier
   * @param position New position of the projection
   * @returns when updated position saved
   */
  update(identifier: string, position: number): Promise<void>;
}
