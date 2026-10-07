import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import { createMemoryStores, flakyInboxRemove, humanMessage } from './testing.js';

describe('定期の依頼 — 落ちた器の後、同じ回が二重に走らない', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const WEEK = 7 * 24 * 60 * MIN;
  const DUE = T0 + WEEK;
  const REQUEST = '週に1回、状態を見て進める';

  async function build(
    stores: ReturnType<typeof createMemoryStores>,
    hangMs?: number,
    startAt: number = DUE,
  ) {
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
    let clock = new Date(startAt);
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
    const dead = await build(stores, 600_000);
    expect(await dead.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(() => timerInputs(dead).length === 1, '1回目のターンが始まる');
    expect((await stores.schedules.get('weekly-check'))?.pendingRun).toBeDefined();

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

  it('(c) 完了まで済んだ回は、受信箱の行を消し損ねたまま落ちても、再起動後にもう一度走らない', async () => {
    const base = createMemoryStores();
    const first = await build(flakyInboxRemove(base, 1_000, 'inbox down').stores);
    expect(await first.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(
      async () => (await base.schedules.get('weekly-check'))?.lastScheduledRunAt !== undefined,
      '1回目が完了する',
    );
    expect(timerInputs(first).length).toBe(1);
    expect((await base.inbox.pending()).count).toBe(1);

    const t2 = await build(base);
    await t2.tick(DUE + MIN);
    await flushPendingMicrotasks();
    expect(timerInputs(t2).length).toBe(0);
    const trace = ((await base.journal.list({ types: ['exchange'] })) as { text: string }[]).filter(
      (entry) => entry.text.includes('その回は既に完了していた'),
    );
    expect(trace.length).toBe(1);
    expect((await base.inbox.pending()).count).toBe(0);
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

  it('(f) 畳むのは完了済みの回だけ。まだ走っていない回の未読の timer 行は配る', async () => {
    const stores = createMemoryStores();
    const first = await build(stores);
    expect(await first.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(
      async () =>
        (await stores.schedules.get('weekly-check'))?.lastScheduledRunAt ===
        new Date(DUE).toISOString(),
      '1回目が完了する',
    );
    const NEXT = DUE + WEEK;
    await stores.inbox.put(
      { type: 'timer', id: 'next-round', at: new Date(NEXT).toISOString(), kind: 'weekly-check' },
      new Date(NEXT).toISOString(),
    );
    const t2 = await build(stores, undefined, NEXT + MIN);
    await t2.tick(NEXT + MIN);
    await waitFor(
      async () =>
        (await stores.schedules.get('weekly-check'))?.lastScheduledRunAt ===
        new Date(NEXT).toISOString(),
      '次の回が完了する',
    );
    await t2.tick(NEXT + 2 * MIN);
    await flushPendingMicrotasks();
    expect(timerInputs(t2).length).toBe(1);
  });
});
