import { IDomainCommand } from './Command';
import { IDomainEvent } from './Event';

import { IVersionedEntity, makeVersionedEntity } from './Entity';

export interface IAggregateInstance<T> {
  // Boolean value indicating whether this instance already exists or is not yet created
  exists: boolean;

  // Current state of the aggregate
  state: T;

  // Current version of the aggregate
  version: number;
}

export interface IEventHandlerMap<T> {
  [s: string]: (state: T, event: IDomainEvent) => T;
}

export interface ICommandHandlerMap<T> {
  [s: string]: (entity: IAggregateInstance<T>, command: IDomainCommand) => IDomainEvent | IDomainEvent[] | void;
}

export interface IAggregateDefinition<T> {
  name: string;

  initialState: T;

  getNextId?: () => string;

  eventHandlers: IEventHandlerMap<T>;

  commands: ICommandHandlerMap<T>;
}

export interface IAggregate<T> {
  readonly name: string;
  rehydrate: (
    events: IDomainEvent[],
    snapshot?: IVersionedEntity<T>
  ) => IVersionedEntity<T>;
  applyCommand: (
    entity: IAggregateInstance<T>,
    command: IDomainCommand
  ) => IDomainEvent | IDomainEvent[] | void;
}

export function createAggregate<T>(
  definition: IAggregateDefinition<T>
): IAggregate<T> {
  const {
    name: aggregateName,
    commands,
    eventHandlers,
    initialState
  } = definition;

  const applyEvent = (entity: IVersionedEntity<T>, event: IDomainEvent) => {
    const { name } = event;
    const updatedState =
      eventHandlers[name] && eventHandlers[name](entity.state, event);

    return entity.update!(updatedState);
  };

  const initialEntity = makeVersionedEntity({
    state: initialState,
    version: 0
  });

  const rehydrate = (events: IDomainEvent[], snapshot?: IVersionedEntity<T>) =>
    events.reduce(applyEvent, snapshot || initialEntity);

  const applyCommand = (
    entity: IAggregateInstance<T>,
    command: IDomainCommand
  ) => {
    const { name } = command;
    const events = commands[name] && commands[name](entity, command);

    if (events !== undefined) {
      return Array.isArray(events) ? events : [events]
    }
    return []
  };

  return {
    applyCommand,
    rehydrate,
    name: aggregateName
  };
}
