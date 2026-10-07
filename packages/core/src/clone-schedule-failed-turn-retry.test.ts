import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import { createMemoryStores } from './testing.js';

describe('定期の依頼 — 失敗したターンは元の回として後退しながら再試行される（#2739）', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const WEEK = 7 * 24 * 60 * MIN;
  const DUE = T0 + WEEK;

  async function build() {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-check',
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: '週に1回、状態を見て進める',
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    const state = { failing: true };
    const sdk = fakeSdk(() => '進めた', {
      resultFor: () =>
        state.failing
          ? { subtype: 'error_during_execution', text: 'internal failure: something broke' }
          : undefined,
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
      at: (ms: number) => {
        clock = new Date(ms);
        return clock;
      },
    };
  }

  const failureLines = async (stores: Awaited<ReturnType<typeof build>>['stores']) =>
    ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).filter((entry) =>
      entry.text.includes('ターンが失敗で終わった'),
    );

  it('失敗の後は 10分 → 30分 と後退して同じ回を配り直し、動けば完了して本来の次回へ戻る', async () => {
    const t = await build();

    expect(await t.tick(DUE)).toEqual(['weekly-check']);
    await waitFor(async () => (await failureLines(t.stores)).length === 1, '失敗の行が1本');
    const first = (await t.stores.schedules.get('weekly-check'))?.pendingRun;
    expect(first?.at).toBe(new Date(DUE).toISOString());

    expect(await t.tick(DUE + 9 * MIN)).toEqual([]);
    expect(await t.tick(DUE + 10 * MIN)).toEqual(['weekly-check']);
    await waitFor(async () => (await failureLines(t.stores)).length === 2, '2本目の失敗');
    expect((await t.stores.schedules.get('weekly-check'))?.pendingRun).toEqual(first);

    expect(await t.tick(DUE + 10 * MIN + 29 * MIN)).toEqual([]);
    t.state.failing = false;
    expect(await t.tick(DUE + 10 * MIN + 30 * MIN)).toEqual(['weekly-check']);
    await waitFor(
      async () => (await t.stores.schedules.get('weekly-check'))?.pendingRun === undefined,
      '成功して印が消える',
    );
    const done = await t.stores.schedules.get('weekly-check');
    expect(done?.lastScheduledRunAt).toBe(new Date(DUE).toISOString());
    const input = t.sdk.calls.flatMap((call) => call.inputs).join('\n');
    expect(input).toContain('週に1回、状態を見て進める');
    expect(input).toContain('引き受けたまま終わっていない');
    expect(input).toContain(new Date(DUE).toISOString());

    expect(await t.tick(DUE + 3 * 60 * MIN)).toEqual([]);
    await t.clone.stop();
  });

  it('後退を使い切ったら、印を残したまま止まる（次の周期か再起動に任せる）', async () => {
    const t = await build();
    let now = DUE;
    expect(await t.tick(now)).toEqual(['weekly-check']);
    await waitFor(async () => (await failureLines(t.stores)).length === 1, '失敗 1');
    const delays = [10, 30, 120, 360, 720];
    for (const [index, minutes] of delays.entries()) {
      now += minutes * MIN;
      expect(await t.tick(now - MIN)).toEqual([]);
      expect(await t.tick(now)).toEqual(['weekly-check']);
      await waitFor(
        async () => (await failureLines(t.stores)).length === index + 2,
        `失敗 ${index + 2}`,
      );
    }
    expect(await t.tick(now + 24 * 60 * MIN)).toEqual([]);
    const left = await t.stores.schedules.get('weekly-check');
    expect(left?.pendingRun?.at).toBe(new Date(DUE).toISOString());
    expect(left?.lastScheduledRunAt).toBeUndefined();
    await t.clone.stop();
  });
});
