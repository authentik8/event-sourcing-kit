import test from 'ava';
import { Counter } from './_helpers';

test('AggregateRepository: save & retrieve', async (t: any) => {
  const { repository } = t.context;

  const counterId = 'counter1';

  let counterState = await repository.getById(counterId);
  const events = await Counter.applyCommand(
    counterState,
    { name: 'increment', data: { by: 2 }, reject: () => 'rejected' },
    {}
  );
  await repository.save(counterId, events, 0);

  counterState = await repository.getById(counterId);

  t.is(counterState.version, 1);
  t.is(counterState.state.value, 2);
});
