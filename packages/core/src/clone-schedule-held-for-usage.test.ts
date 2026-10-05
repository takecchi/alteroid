import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * Issue #2814。定期の依頼のターンが枠保持（`heldForUsage`）で終わっても、その回は
 * 受信箱の未読として残るので、再起動でも枠が開いたときでも元の回として 1 回だけ配り直される。
 */
describe('定期の依頼 — 枠保持で終わった回は消えずに 1 回だけ配り直される（#2814）', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const WEEK = 7 * 24 * 60 * MIN;
  const DUE = T0 + WEEK;
  const spendLimit = "You've hit your individual spend limit for this account.";

  async function build(stores = createMemoryStores(), state = { blocked: true }) {
    if ((await stores.schedules.get('weekly-check')) === null) {
      await stores.schedules.put({
        kind: 'weekly-check',
        spec: { type: 'every', minutes: 7 * 24 * 60 },
        request: '週に1回、状態を見て進める',
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
      });
    }
    const sdk = fakeSdk(() => '進めた', {
      resultFor: () =>
        state.blocked ? { subtype: 'error_during_execution', text: spendLimit } : undefined,
    });
    let clock = new Date(DUE);
    // eslint-disable-next-line prefer-const -- 前方参照（デーモンの index.ts と同じ形）
    let scheduler: ReturnType<typeof createScheduler>;
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      onScheduledRunNotStarted: (kind, delayMs) => scheduler.retrySoon(kind, delayMs),
    });
    scheduler = createScheduler({
      entries: [],
      post: (event) => clone.post(event),
      schedules: stores.schedules,
      now: () => clock,
    });
    await scheduler.refresh();
    return {
      stores,
      clone,
      scheduler,
      state,
      sdk,
      tick: async (ms: number) => {
        await scheduler.refresh();
        return scheduler.tick(new Date((clock = new Date(ms)).getTime()));
      },
    };
  }

  const timerInputs = (t: Awaited<ReturnType<typeof build>>) =>
    t.sdk.calls
      .flatMap((call) => call.inputs)
      .filter((text) => text.includes('週に1回、状態を見て進める'));

  it('(a) 枠保持の間に再起動しても、その回は元の回として配り直される', async () => {
    const t = await build();
    expect(await t.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(
      () => timerInputs(t).length === 1 && t.clone.usageBlocked,
      '1回目のターンが枠で保持される',
    );
    await flushPendingMicrotasks();
    await t.clone.stop();

    // 再起動: 同じストアで作り直す。枠は開いている
    const t2 = await build(t.stores, { blocked: false });
    await t2.scheduler.refresh();
    // スケジューラ（`#firstDue`）が印を拾い、受信箱の未読と合わせて 1 回だけ走る
    await t2.tick(DUE + MIN);
    await waitFor(() => timerInputs(t2).length >= 1, '再起動後に元の回が走る');
    await waitFor(
      async () => (await t2.stores.schedules.get('weekly-check'))?.pendingRun === undefined,
      '配り直しが走って完了する',
    );
    // 印の側（スケジューラ）と受信箱の未読の両方から配られても、1回しか走らない
    await t2.tick(DUE + 2 * MIN);
    await flushPendingMicrotasks();
    expect(timerInputs(t2).length).toBe(1);
    const done = await t2.stores.schedules.get('weekly-check');
    expect(done?.lastScheduledRunAt).toBe(new Date(DUE).toISOString());
    await t2.clone.stop();
  });

  it('(b) 枠が開いて defer から配り直された回は、元の回として 1 回だけ走って完了する', async () => {
    const t = await build();
    expect(await t.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(
      () => timerInputs(t).length === 1 && t.clone.usageBlocked,
      '1回目のターンが枠で保持される',
    );
    await flushPendingMicrotasks();

    t.state.blocked = false;
    t.clone.post(humanMessage('枠が開いたか見て'));
    await waitFor(
      async () => (await t.stores.schedules.get('weekly-check'))?.lastScheduledRunAt !== undefined,
      '配り直された回が完了する',
    );
    const done = await t.stores.schedules.get('weekly-check');
    expect(done?.pendingRun).toBeUndefined();
    expect(done?.lastScheduledRunAt).toBe(new Date(DUE).toISOString());
    // 保持中の1回 + 配り直しの1回。印の側からの二重配達が無い
    await flushPendingMicrotasks();
    expect(timerInputs(t).length).toBe(2);
    // 配り直しのプロンプトに「走りかけ」の断り書きは付かない（保持した回は走っていない）
    expect(timerInputs(t)[1]).not.toContain('デーモンがその途中で落ちた');
    await t.clone.stop();
  });
});
