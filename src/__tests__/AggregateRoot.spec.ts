import test from 'ava';
import Joi from 'joi';

import { createAggregateRoot } from '../AggregateRoot';
import { createCommand, createCommandValidator } from '../Command';
import { CommandValidationError, DomainError } from '../errors';
import { createEvent } from '../Event';
import { IAggregateDefinition } from '../interfaces';

interface ICounter {
  value: number;
}

const timeout = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const definition: IAggregateDefinition<ICounter> = {
  commands: {
    *addOneAndDouble(entity, _) {
      entity = yield entity.publish('incremented');
      yield entity.publish('incrementedBy', { step: entity.state.value });
    },
    arrayIncrements: [
      (entity, _) => {
        entity.publish('incremented');
      },
      (entity, _) => {
        entity.publish('incremented');
      },
      (entity, _) => {
        entity.publish('incrementedBy', { step: entity.state.value + 2 });
      }
    ],
    async *delayedIncrement(entity, _) {
      await timeout(25);
      yield entity.publish('incremented');
    },
    increment(entity, _) {
      entity.publish('incremented');
    },
    incrementByPositive(entity, { data: { step } }) {
      if (step <= 0) {
        throw new DomainError('Must increment by positive number');
      }
      entity.publish('incrementedBy', { step });
    },
    incrementByDynamic: [
      createCommandValidator({
        steps: Joi.array().items(Joi.number().integer())
      }),
      function* incrementByDynamic(entity, command) {
        for (const step of command.data.steps) {
          yield entity.publish('incrementedBy', { step });
        }
      }
    ]
  },
  initialState: {
    value: 0
  },
  name: 'counter',
  reducer: {
    incremented: (state, _) => ({
      ...state,
      value: state.value + 1
    }),
    incrementedBy: (state, event) => ({
      ...state,
      value: state.value + event.data.step
    })
  }
};

const counterAggregate = createAggregateRoot(definition);

test('simple command handler', async t => {
  const incrementedByOne = createCommand('increment', 0);

  const events = await counterAggregate.applyCommand(
    counterAggregate.initialState,
    incrementedByOne
  );

  t.is(events.length, 1);
});

test('handle domain error', async t => {
  const command = createCommand('incrementByPositive', 0, { step: -2 });
  const shouldThrow = () =>
    counterAggregate.applyCommand(counterAggregate.initialState, command);

  await t.throwsAsync(shouldThrow, { name: 'DomainError' });
});

test('multiple yielding command handler', async t => {
  const incrementedByDynamic = createCommand('incrementByDynamic', 0, {
    steps: [1, 2, 3, 4]
  });

  const events = await counterAggregate.applyCommand(
    counterAggregate.initialState,
    incrementedByDynamic
  );

  t.is(events.length, 4);
  t.deepEqual(events, [
    createEvent('incrementedBy', { step: 1 }),
    createEvent('incrementedBy', { step: 2 }),
    createEvent('incrementedBy', { step: 3 }),
    createEvent('incrementedBy', { step: 4 })
  ]);
});

test('command validation', async t => {
  const badCommand = createCommand('incrementByDynamic', 0, { steps: 'foo' });
  const shouldThrow = () =>
    counterAggregate.applyCommand(counterAggregate.initialState, badCommand);

  await t.throwsAsync(shouldThrow, {
    instanceOf: CommandValidationError
  });
});

test('stateful multiple yielding', async t => {
  const initial = {
    exists: true,
    state: { value: 5 },
    version: 1
  };

  const addOneAndDoubleCommand = createCommand('addOneAndDouble', 1);

  const events = await counterAggregate.applyCommand(
    initial,
    addOneAndDoubleCommand
  );
  t.is(events.length, 2);
  t.deepEqual(events, [
    createEvent('incremented'),
    createEvent('incrementedBy', { step: 6 })
  ]);
});

test('asynchronous yielding', async t => {
  const initial = counterAggregate.initialState;
  const delayedIncrement = createCommand('delayedIncrement', 0);
  const events = await counterAggregate.applyCommand(initial, delayedIncrement);

  t.is(events.length, 1);
  t.deepEqual(events, [createEvent('incremented')]);
});

test('multiple command handlers', async t => {
  const initial = counterAggregate.initialState;
  const arrayIncrement = createCommand('arrayIncrements', 0);
  const events = await counterAggregate.applyCommand(initial, arrayIncrement);
  t.is(events.length, 3);
  t.deepEqual(events, [
    createEvent('incremented'),
    createEvent('incremented'),
    createEvent('incrementedBy', { step: 4 })
  ]);
});
