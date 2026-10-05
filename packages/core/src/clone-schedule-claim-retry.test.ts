import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #2741。`claimRun` が読めない・書けないで動かなかった発火は、スケジューラの
 * メモリ上の次回が1周期先へ進んだまま、再起動まで取り戻されなかった。
 * デーモンと同じ配線（スケジューラ → クローン、クローン → スケジューラへ「動いていない」）で見る。
 */
describe('定期の依頼 — 引き受けに失敗した発火は短い間隔で再試行される（#2741）', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');

  async function build() {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-check',
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: '週に1回、状態を見て進める',
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    const real = stores.schedules.claimRun.bind(stores.schedules);
    const state = { failing: true, claims: 0 };
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      state.claims += 1;
      if (state.failing) throw new Error('接続が瞬断した');
      return real(kind, expectedUpdatedAt, at, cause);
    };

    const { fn, calls } = fakeSdk(() => '進めた');
    let clock = new Date(T0 + MIN);
    // eslint-disable-next-line prefer-const -- 前方参照（デーモンの index.ts と同じ形）
    let scheduler: ReturnType<typeof createScheduler>;
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      onScheduledRunNotStarted: (kind) => scheduler.retrySoon(kind),
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
      calls,
      clone,
      scheduler,
      state,
      at: (ms: number) => {
        clock = new Date(ms);
        return clock;
      },
    };
  }

  const notRunLines = async (stores: Awaited<ReturnType<typeof build>>['stores']) =>
    ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).filter((entry) =>
      entry.text.includes('この発火では動かない'),
    );

  it('claimRun が落ちた回は、次の周期ではなく短い間隔で据え直され、復旧後の刻みで動く', async () => {
    const t = await build();
    const due = T0 + 7 * 24 * 60 * MIN;

    expect(t.scheduler.tick(t.at(due))).toEqual(['weekly-check']);
    await waitFor(async () => (await notRunLines(t.stores)).length === 1, '動かない行が1本');
    expect(t.calls).toEqual([]);

    // 器が直った。1周期先ではなく、すぐ後の刻みで拾い直される
    t.state.failing = false;
    expect(t.scheduler.tick(t.at(due + 2 * MIN))).toEqual(['weekly-check']);
    await waitFor(
      () => (t.calls[0]?.inputs ?? []).join('\n').includes('週に1回、状態を見て進める'),
      '依頼の本文つきで動く',
    );
    expect((await t.stores.schedules.get('weekly-check'))?.lastRunAt).toBeDefined();

    // 動いた後は本来の次回（1周期先）へ戻る — 高頻度の再試行が居座らない
    expect(t.scheduler.tick(t.at(due + 10 * MIN))).toEqual([]);
    await t.clone.stop();
  });

  it('落ち続けるあいだも、再試行は1刻み（1分）に1回を超えない', async () => {
    const t = await build();
    const due = T0 + 7 * 24 * 60 * MIN;

    t.scheduler.tick(t.at(due));
    await waitFor(async () => (await notRunLines(t.stores)).length === 1, '1本目');
    // 据え直し前の刻みでは何も起きない
    expect(t.scheduler.tick(t.at(due + 10_000))).toEqual([]);
    expect(t.scheduler.tick(t.at(due + MIN))).toEqual(['weekly-check']);
    await waitFor(async () => (await notRunLines(t.stores)).length === 2, '2本目');
    // 1発火あたり3回の書き直し（SCHEDULE_STORE_ATTEMPTS）× 2発火
    expect(t.state.claims).toBe(6);
    await t.clone.stop();
  });
});
