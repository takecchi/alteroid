import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * 定期の依頼の発火が、ターンの途中（または引き受ける前の待ち行列の中）で器が落ちた後、
 * 再起動した器で **同じ回が2回走る**ことを確かめる。
 *
 * 2つの経路が同じ回を配る: (1) 受信箱に未読で残った timer の合図（`#restoreUnread`）、
 * (2) 引き受けの印（`pendingRun`）または取りこぼしの拾い直し（`#firstDue` の catch-up）を
 * 見たスケジューラの配り直し。#2814 の歯は「枠保持で終わった回」（印が既に消えている）だけを
 * 扱っており、途中で落ちた回はどちらの経路も生きている。
 */
describe('定期の依頼 — 落ちた器の後、同じ回が二重に走らない', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const WEEK = 7 * 24 * 60 * MIN;
  const DUE = T0 + WEEK;
  const REQUEST = '週に1回、状態を見て進める';

  async function build(stores: ReturnType<typeof createMemoryStores>, hangMs?: number) {
    if ((await stores.schedules.get('weekly-check')) === null) {
      await stores.schedules.put({
        kind: 'weekly-check',
        spec: { type: 'every', minutes: 7 * 24 * 60 },
        request: REQUEST,
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
      });
    }
    const sdk = fakeSdk(() => '進めた', hangMs === undefined ? {} : { delayMs: hangMs });
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
      inbox: stores.inbox,
      now: () => clock,
    });
    await scheduler.refresh();
    return {
      clone,
      scheduler,
      sdk,
      tick: async (ms: number) => {
        await scheduler.refresh();
        return scheduler.tick(new Date((clock = new Date(ms)).getTime()));
      },
    };
  }

  const timerInputs = (t: Awaited<ReturnType<typeof build>>) =>
    t.sdk.calls.flatMap((call) => call.inputs).filter((text) => text.includes(REQUEST));

  it('(a) ターンの途中で落ちた回は、再起動後に1回だけ走る', async () => {
    const stores = createMemoryStores();
    // 1つ目の器: 発火して引き受けた（pendingRun が立つ）が、ターンが終わらないまま死ぬ
    const dead = await build(stores, 600_000);
    expect(await dead.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(() => timerInputs(dead).length === 1, '1回目のターンが始まる');
    expect((await stores.schedules.get('weekly-check'))?.pendingRun).toBeDefined();

    // 2つ目の器: 同じストアで作り直す
    const t2 = await build(stores);
    await t2.tick(DUE + MIN);
    await waitFor(
      async () => (await stores.schedules.get('weekly-check'))?.pendingRun === undefined,
      '配り直しが完了する',
    );
    await t2.tick(DUE + 2 * MIN);
    await flushPendingMicrotasks();
    expect(timerInputs(t2).length).toBe(1);
  });

  it('(b) 引き受ける前（待ち行列の中）で落ちた回も、再起動後に1回だけ走る', async () => {
    const stores = createMemoryStores();
    // 1つ目の器: 人間のターンが終わらず、発火した timer の合図が受信箱に未読のまま待つ
    const dead = await build(stores, 600_000);
    dead.clone.post(humanMessage('長い話'));
    await waitFor(() => dead.sdk.calls.length >= 1, '人間のターンが始まる');
    expect(await dead.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(async () => (await stores.inbox.pending()).count >= 2, 'timer が未読に積まれる');
    expect((await stores.schedules.get('weekly-check'))?.pendingRun).toBeUndefined();

    const t2 = await build(stores);
    await t2.tick(DUE + MIN);
    await waitFor(
      async () => (await stores.schedules.get('weekly-check'))?.lastScheduledRunAt !== undefined,
      '回が完了する',
    );
    await t2.tick(DUE + 2 * MIN);
    await flushPendingMicrotasks();
    expect(timerInputs(t2).length).toBe(1);
  });

  it('(e) 再起動の無い通常の発火は1回だけ走る', async () => {
    const stores = createMemoryStores();
    const t = await build(stores);
    expect(await t.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(
      async () => (await stores.schedules.get('weekly-check'))?.lastScheduledRunAt !== undefined,
      '回が完了する',
    );
    await t.tick(DUE + MIN);
    await t.tick(DUE + 2 * MIN);
    await flushPendingMicrotasks();
    expect(timerInputs(t).length).toBe(1);
  });
});
