import { describe, expect, it } from 'vitest';

import type { ManagerRecord } from './manager.js';
import { UsageWake } from './usage-wake.js';

// `UsageWake` の 2 つの挑み直し（担当の枠の落ち / 作業者の落ち）の間隔を、失敗の回数ごとの値で縛る。
// 公開の口（resumeStoppedByUsage / settleStalled）だけを通し、共有の Map に書かれる `{ failures, nextAt }` を読む。
//   - 担当の枠の落ち: 基準 1 分・上限 30 分
//   - 作業者の落ち: 基準 1 分・上限 5 分
// 回数 1 回目は基準、以後は倍々、上限を超えたら上限で止まる。

type Deps = ConstructorParameters<typeof UsageWake>[0];
type Retry = Map<string, { failures: number; nextAt: number }>;

const ID = 'mgr-backoff';
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function setup() {
  const clock = { now: T0 };
  const usageStopped = new Set<string>();
  const usageWakeRetry: Retry = new Map();
  const workerLimitStopped: Deps['workerLimitStopped'] = new Map();
  const workerLimitWakeRetry: Retry = new Map();
  const rotationFoldDueAt = new Map<string, number>();
  const records = new Map<string, ManagerRecord>();
  const deps = {
    records,
    usageStopped,
    usageWakeOwed: new Set<string>(),
    usageWakeRetry,
    usageNudgeInFlight: new Map(),
    workerLimitStopped,
    workerLimitWakeRetry,
    rotationFoldDueAt,
    resetTimeSkewMatches: new Map(),
    supersedePending: new Map(),
    tokenIdentities: new Map(),
    stores: {},
    now: () => clock.now,
    stopped: () => false,
    // 台帳の読みが落ちる: 担当の起こし直しは `skipped`（届かなかった）になる
    load: async () => {
      throw new Error('この検証が仕込んだ load の失敗');
    },
    findJob: async () => undefined,
    persist: async () => undefined,
    journal: async () => undefined,
    journalExchange: async () => undefined,
    tokenIdentity: () => undefined,
    tokenAvailability: undefined,
    send: async () => ({ outcome: 'delivered' }),
    queueSynthesizedNotice: () => undefined,
    observeForTokenRotation: async () => undefined,
    sessionTokenFingerprintOf: () => undefined,
    beforeWakes: async () => undefined,
    rateLimits: () => new Map(),
  } as unknown as Deps;
  return {
    wake: new UsageWake(deps),
    clock,
    usageStopped,
    usageWakeRetry,
    workerLimitStopped,
    workerLimitWakeRetry,
    rotationFoldDueAt,
    records,
  };
}

describe('担当の枠の落ちの挑み直しの間隔（基準 1 分・上限 30 分）', () => {
  it('失敗の回数 1・2・3… で倍々に伸び、上限 30 分で止まる', async () => {
    const s = setup();
    s.usageStopped.add(ID);
    const seen: { failures: number | undefined; delay: number | undefined }[] = [];
    for (let i = 0; i < 9; i += 1) {
      await s.wake.resumeStoppedByUsage();
      const retry = s.usageWakeRetry.get(ID);
      seen.push({
        failures: retry?.failures,
        delay: retry === undefined ? undefined : retry.nextAt - s.clock.now,
      });
    }
    expect(seen).toEqual([
      { failures: 1, delay: 1 * MIN },
      { failures: 2, delay: 2 * MIN },
      { failures: 3, delay: 4 * MIN },
      { failures: 4, delay: 8 * MIN },
      { failures: 5, delay: 16 * MIN },
      // 32 分は上限を超える: 30 分で止まる
      { failures: 6, delay: 30 * MIN },
      { failures: 7, delay: 30 * MIN },
      { failures: 8, delay: 30 * MIN },
      { failures: 9, delay: 30 * MIN },
    ]);
  });

  it('背景処理の待ちの上限の時刻（rotationFoldDueAt）が近いと、間隔はそこまで縮む。ただし最短でも 1 分は空ける', async () => {
    const delays: number[] = [];
    // 回数 3 回目（素の間隔 4 分）で、待ちの上限の時刻が 10 秒後・100 秒後・10 分後のとき
    for (const foldDueIn of [10 * 1000, 100 * 1000, 10 * MIN]) {
      const s = setup();
      s.usageStopped.add(ID);
      for (let i = 0; i < 2; i += 1) await s.wake.resumeStoppedByUsage();
      s.rotationFoldDueAt.set(ID, s.clock.now + foldDueIn);
      await s.wake.resumeStoppedByUsage();
      const retry = s.usageWakeRetry.get(ID);
      expect(retry?.failures).toBe(3);
      delays.push((retry?.nextAt ?? 0) - s.clock.now);
    }
    expect(delays).toEqual([1 * MIN, 100 * 1000, 4 * MIN]);
  });
});

describe('作業者の落ちの挑み直しの間隔（基準 1 分・上限 5 分）', () => {
  it('失敗の回数 1・2・3… で倍々に伸び、上限 5 分で止まる', async () => {
    const s = setup();
    // 印はあるが、担当は走っている（done でない）ので `wakeForWorkerLimit` は起こさずに false を返し、印は残る
    s.workerLimitStopped.set(ID, { preRotationKey: true, turnStartedAt: undefined });
    s.records.set(ID, { job: { id: ID, status: 'running' } } as unknown as ManagerRecord);
    const seen: { failures: number | undefined; delay: number | undefined }[] = [];
    for (let i = 0; i < 7; i += 1) {
      const before = s.workerLimitWakeRetry.get(ID);
      // 次の挑み直しの時刻まで進める（前の回の nextAt に届かない間は掃きが飛ばす）
      if (before !== undefined) s.clock.now = before.nextAt;
      await s.wake.settleStalled();
      const retry = s.workerLimitWakeRetry.get(ID);
      seen.push({
        failures: retry?.failures,
        delay: retry === undefined ? undefined : retry.nextAt - s.clock.now,
      });
    }
    expect(seen).toEqual([
      { failures: 1, delay: 1 * MIN },
      { failures: 2, delay: 2 * MIN },
      { failures: 3, delay: 4 * MIN },
      // 8 分は上限を超える: 5 分で止まる
      { failures: 4, delay: 5 * MIN },
      { failures: 5, delay: 5 * MIN },
      { failures: 6, delay: 5 * MIN },
      { failures: 7, delay: 5 * MIN },
    ]);
  });

  it('次の挑み直しの時刻に届かない間は、掃きは起こしにも数え直しにも行かない', async () => {
    const s = setup();
    s.workerLimitStopped.set(ID, { preRotationKey: true, turnStartedAt: undefined });
    s.records.set(ID, { job: { id: ID, status: 'running' } } as unknown as ManagerRecord);
    await s.wake.settleStalled();
    const first = s.workerLimitWakeRetry.get(ID);
    s.clock.now = (first?.nextAt ?? 0) - 1;
    await s.wake.settleStalled();
    expect(s.workerLimitWakeRetry.get(ID)).toEqual(first);
  });
});
