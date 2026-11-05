import type { ManagerPool } from './manager.js';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/**
 * 試験の偽の `ManagerPool` の工場。口の既定は「何もしない・空・`undefined`」で、呼ぶと値が要る口
 * （`start` など）は投げる。試験が見る口だけ `overrides` で上書きする。
 * 口を足すとき、偽を1つずつ直さずここへ既定を足す。
 */
export function fakeManagerPool(overrides: Partial<ManagerPool> = {}): ManagerPool {
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () => Promise.resolve([]),
    denials: () => [],
    runners: notImplemented,
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    ...overrides,
  };
}
