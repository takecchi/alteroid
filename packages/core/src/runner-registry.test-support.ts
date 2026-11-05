import type { RunnerRegistry } from './runner-protocol.js';

/**
 * 試験の偽の `RunnerRegistry` の工場。口の既定は「何もしない・空・`null`・`undefined`」で、置き先を選ぶ `select` は投げる
 * （配置は、それを検証する試験が `overrides` で持つ）。試験が見る口だけ `overrides` で上書きする。
 * 口を足すとき、偽を1つずつ直さずここへ既定を足す。
 */
export function fakeRunnerRegistry(overrides: Partial<RunnerRegistry> = {}): RunnerRegistry {
  return {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    select: () => Promise.reject(new Error('この偽の名簿では select を使わない')),
    register: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    vacate: () => undefined,
    noteManagerFailed: () => undefined,
    notePidsSaturationSign: () => undefined,
    pidsSaturationOf: () => undefined,
    entries: () => [],
    subscribe: () => () => {},
    stop: () => Promise.resolve(),
    ...overrides,
  };
}
