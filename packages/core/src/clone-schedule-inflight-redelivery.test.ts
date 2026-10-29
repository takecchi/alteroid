import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import { createMemoryStores } from './testing.js';

// 数分おきの依頼で、ターンが周期より長引くと、次の刻みでスケジューラが実行中の回を「落ちた回」と見て配り直していた。
// 配り直した回は先の回が終わった後に同じ回としてもう一度走り、その刻みの本来の回は発火されずに飛ばされた。
describe('定期の依頼 — 実行中の回を、長引いただけで配り直さない（#4605）', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const DUE = T0 + 5 * MIN;
  const NEXT = DUE + 5 * MIN;
  const REQUEST = '5分おきに状態を見て進める';

  async function build(stores: ReturnType<typeof createMemoryStores>) {
    await stores.schedules.put({
      kind: 'every-5',
      spec: { type: 'every', minutes: 5 },
      request: REQUEST,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    // ターンは周期（の刻み）より長引く: 2回目の刻みは1回目のターンの最中に来る
    const sdk = fakeSdk(() => '進めた', { delayMs: 800 });
    let clock = new Date(DUE);
    // eslint-disable-next-line prefer-const -- 前方参照（デーモンの index.ts と同じ形）
    let scheduler: ReturnType<typeof createScheduler>;
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      onScheduledRunNotStarted: (kind, delayMs) => scheduler.retrySoon(kind, delayMs),
      onScheduledRunClaimed: (kind, at) => scheduler.noteClaimed(kind, at),
    });
    scheduler = createScheduler({
      entries: [],
      post: (event) => clone.post(event),
      schedules: stores.schedules,
      inbox: stores.inbox,
      now: () => clock,
    });
    await scheduler.refresh();
    return {
      sdk,
      tick: async (ms: number) => {
        await scheduler.refresh();
        return scheduler.tick(new Date((clock = new Date(ms)).getTime()));
      },
    };
  }

  it('長引いている回は配り直さず、次の刻みの本来の回を発火して、それぞれ1回ずつ走る', async () => {
    const stores = createMemoryStores();
    const t = await build(stores);
    const timerInputs = () =>
      t.sdk.calls.flatMap((call) => call.inputs).filter((text) => text.includes(REQUEST));

    expect(await t.tick(DUE)).toEqual(['every-5']);
    await waitFor(() => timerInputs().length === 1, '1回目のターンが始まる');
    expect((await stores.schedules.get('every-5'))?.pendingRun?.at).toBe(
      new Date(DUE).toISOString(),
    );

    // 1回目がまだ終わっていない間に、次の刻みが来る
    expect(await t.tick(NEXT)).toEqual(['every-5']);

    await waitFor(() => timerInputs().length === 2, '2回目のターンが始まる');
    await waitFor(
      async () => (await stores.schedules.get('every-5'))?.pendingRun === undefined,
      '2回目が完了する',
    );
    await flushPendingMicrotasks();

    // 2回目は「1回目をもう一度」ではなく、次の刻みの本来の回
    expect((await stores.schedules.get('every-5'))?.lastScheduledRunAt).toBe(
      new Date(NEXT).toISOString(),
    );
    expect(timerInputs().length).toBe(2);
  });
});
