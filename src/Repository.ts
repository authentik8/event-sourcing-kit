import { inject, injectable } from 'inversify';
import uuid from 'uuid';

import { FRAMEWORK_TYPES } from './constants';
import {
  IAggregateEvent,
  IAggregateIdentifier,
  IAggregateRoot,
  IAggregateState,
  IDomainEvent,
  IEventStore,
  IRepository
} from './interfaces';

@injectable()
class Repository<T> implements IRepository<T> {
  private _aggregate: IAggregateRoot<T>;
  private _store: IEventStore;

  constructor(
    aggregate: IAggregateRoot<T>,
    @inject(FRAMEWORK_TYPES.eventstore.EventStore) store: IEventStore
  ) {
    this._aggregate = aggregate;
    this._store = store;
  }

  public async save(id: string, events: IDomainEvent[], version: number) {
    const aggregateId = this._getAggregateId(id);
    return this._store.save(aggregateId, events, version);
  }

  public async getById(id: string): Promise<IAggregateState<T>> {
    const aggregateId = this._getAggregateId(id);
    const events = await this._store.loadEvents(aggregateId);
    return this._createInstance(id, events);
  }

  public async getNextId(): Promise<string> {
    return Promise.resolve(uuid.v4());
  }

  private _getAggregateId(id: string): IAggregateIdentifier {
    return { id, name: this._aggregate.name };
  }

  private _createInstance(
    id: string,
    events: IAggregateEvent[]
  ): IAggregateState<T> {
    const { state, version } = this._aggregate.rehydrate(id, events);
    return { id, state, version, exists: version > 0 };
  }
}

export default Repository;
