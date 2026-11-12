import type { ManagerPool } from './manager.js';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/**
 * 試験の偽の `ManagerPool` の工場。口の既定は「何もしない・空・`undefined`」で、呼ぶと値が要る口
 * （`start` など）は投げる。試験が見る口だけ `overrides` で上書きする。
 * 口を足すとき、偽を1つずつ直さずここへ既定を足す。
 *
 * `get` / `runningManagerPinning` の既定は、同じ偽の `list` / `runningManagerOwning`（上書き後のもの）へ寄せる:
 * 偽が1件読みを別に持たない限り、一覧・広い保護と同じ答えになる。
 * `transcriptTail` / `runnerPidsSaturation` / `runnerHasCapability` は省略可能のままなので既定を置かない
 * （持たない偽は、呼ぶ側が全文・材料なし・`false` に倒す）。
 */
export function fakeManagerPool(overrides: Partial<ManagerPool> = {}): ManagerPool {
  const pool: ManagerPool = {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () => Promise.resolve([]),
    get: async (managerId) => (await pool.list()).find((entry) => entry.managerId === managerId),
    denials: () => [],
    runners: notImplemented,
    pushHealthOf: () => undefined,
    pluginLoadOf: () => undefined,
    managerPeersOf: () => ({ status: 'unknown' }),
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runnerReportedModels: () => undefined,
    runnerReportedAnthropicRoute: () => undefined,
    autoFoldOnPlacementPressure: () => undefined,
    autoFoldUnderPressure: () => Promise.resolve(),
    repairStrandedTasks: () => Promise.resolve(),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    runningManagerPinning: (archiveId) => pool.runningManagerOwning(archiveId),
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    noteSilentManagers: () => Promise.resolve(),
    sweepRescueRefs: () => Promise.resolve(),
    deliverHeldMessages: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    ...overrides,
  };
  return pool;
}
