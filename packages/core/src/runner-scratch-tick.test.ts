import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { RunnerScratchTick } from './runner-scratch-tick.js';

// `RunnerScratchTick` の直の試験。口は偽物、`pruneStaleAttachmentDirs`・`pruneStaleOutboxRoots` は `vi.mock` の偽物で、決着は試験が握る。
// 時計は注入（`vi.useFakeTimers` の `Date`）。実時間では待たず、Promise の連鎖が落ち着くまでは微小タスクを回数の上限つきで回す。

const h = vi.hoisted(() => ({
  log: [] as string[],
  attachmentCalls: [] as unknown[][],
  outboxCalls: [] as unknown[][],
  attachments: (): Promise<number> => Promise.resolve(0),
  outbox: (): Promise<void> => Promise.resolve(),
  attachmentsThrow: undefined as Error | undefined,
  outboxThrow: undefined as Error | undefined,
}));

vi.mock('./runner-attachments.js', () => ({
  pruneStaleAttachmentDirs: (...args: unknown[]) => {
    h.log.push('attachments');
    h.attachmentCalls.push(args);
    if (h.attachmentsThrow !== undefined) throw h.attachmentsThrow;
    return h.attachments();
  },
}));

vi.mock('./runner-outbox.js', () => ({
  pruneStaleOutboxRoots: (...args: unknown[]) => {
    h.log.push('outbox');
    h.outboxCalls.push(args);
    if (h.outboxThrow !== undefined) throw h.outboxThrow;
    return h.outbox();
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Promise の連鎖（`.catch().then().finally()`）が落ち着くまで微小タスクを回す。時間は進めない。 */
async function settle(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const sweepEvent: RunnerEvent = {
  type: 'scratch_sweep',
  runnerId: 'runner-t',
  removed: [],
  kept: [],
} as unknown as RunnerEvent;

interface Rig {
  tick: RunnerScratchTick;
  abort: AbortController;
  emitted: RunnerEvent[];
  sweepCalls: { signal: AbortSignal; runnerId: string }[];
  keys: { current: string[] };
  removal: { marker: string };
  set: {
    sweep: (() => Promise<unknown>) | undefined;
    kickThrow: Error | undefined;
    sweepThrow: Error | undefined;
    emitThrow: Error | undefined;
    sessionKeysThrow: Error | undefined;
    outboxRemovalThrow: Error | undefined;
  };
}

function rig(): Rig {
  const abort = new AbortController();
  const emitted: RunnerEvent[] = [];
  const sweepCalls: { signal: AbortSignal; runnerId: string }[] = [];
  const keys = { current: ['mgr-a', 'mgr-b'] };
  const removal = { marker: 'removal' };
  const set: Rig['set'] = {
    sweep: undefined,
    kickThrow: undefined,
    sweepThrow: undefined,
    emitThrow: undefined,
    sessionKeysThrow: undefined,
    outboxRemovalThrow: undefined,
  };
  const tick = new RunnerScratchTick({
    attachmentsRoot: '/att',
    outboxRoot: '/outbox',
    outboxStagedRoot: '/staged',
    rescueStagedRoot: '/rescue',
    sessionKeys: () => {
      if (set.sessionKeysThrow !== undefined) throw set.sessionKeysThrow;
      return [...keys.current];
    },
    outboxRemoval: () => {
      if (set.outboxRemovalThrow !== undefined) throw set.outboxRemovalThrow;
      h.log.push('outboxRemoval');
      return removal as never;
    },
    kickMcpConfigSweep: () => {
      h.log.push('kick');
      if (set.kickThrow !== undefined) throw set.kickThrow;
    },
    sweeper: {
      sweep: (signal: AbortSignal, runnerId: string) => {
        h.log.push('sweep');
        sweepCalls.push({ signal, runnerId });
        if (set.sweepThrow !== undefined) throw set.sweepThrow;
        return (set.sweep ?? (() => Promise.resolve(null)))() as never;
      },
    },
    scratchAbort: abort,
    runnerId: 'runner-t',
    emit: (event) => {
      h.log.push('emit');
      emitted.push(event);
      if (set.emitThrow !== undefined) throw set.emitThrow;
    },
  });
  return { tick, abort, emitted, sweepCalls, keys, removal, set };
}

const count = (label: string): number => h.log.filter((entry) => entry === label).length;

describe('RunnerScratchTick.tick', () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    h.log.length = 0;
    h.attachmentCalls.length = 0;
    h.outboxCalls.length = 0;
    h.attachments = () => Promise.resolve(0);
    h.outbox = () => Promise.resolve();
    h.attachmentsThrow = undefined;
    h.outboxThrow = undefined;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await settle();
    process.off('unhandledRejection', onUnhandled);
    // `.catch` が外れると、拒否が誰にも受けられずここへ来る
    expect(unhandled).toEqual([]);
  });

  it('同期で void を返し、1 回の呼びの中で 添付 → 出し箱の設定 → 出し箱 → kick → sweep の順に（await を待たずに）呼ぶ', () => {
    h.attachments = () => new Promise(() => undefined);
    h.outbox = () => new Promise(() => undefined);
    const r = rig();
    const returned: unknown = r.tick.tick();
    expect(returned).toBeUndefined();
    expect(h.log).toEqual(['attachments', 'outboxRemoval', 'outbox', 'kick', 'sweep']);
  });

  it('渡す値: 添付は (root, 担当の一覧, now)。出し箱は (3 つの root, 担当の一覧を返す関数, now, 設定)。sweep は (参照の signal, runnerId)', () => {
    const r = rig();
    r.tick.tick();
    expect(h.attachmentCalls).toEqual([['/att', ['mgr-a', 'mgr-b'], T0.getTime()]]);
    const [roots, keysFn, now, removal] = h.outboxCalls[0] ?? [];
    expect(roots).toEqual({
      outboxRoot: '/outbox',
      stagedRoot: '/staged',
      rescueStagedRoot: '/rescue',
    });
    expect(typeof keysFn).toBe('function');
    r.keys.current = ['mgr-c'];
    expect((keysFn as () => string[])()).toEqual(['mgr-c']);
    expect(now).toBe(T0.getTime());
    expect(removal).toBe(r.removal);
    expect(r.sweepCalls).toHaveLength(1);
    expect(r.sweepCalls[0]?.signal).toBe(r.abort.signal);
    expect(r.sweepCalls[0]?.runnerId).toBe('runner-t');
  });

  it('Date.now() は添付と出し箱で別々に読む（時計が tick の中で進んでも、それぞれの呼びの時点の値）', () => {
    const r = rig();
    h.attachments = () => {
      vi.setSystemTime(new Date(T0.getTime() + 7));
      return Promise.resolve(0);
    };
    r.tick.tick();
    expect(h.attachmentCalls[0]?.[2]).toBe(T0.getTime());
    expect(h.outboxCalls[0]?.[2]).toBe(T0.getTime() + 7);
  });

  it('2 回目の tick も、前が終わっていれば同じ順で呼び直す', async () => {
    const r = rig();
    r.tick.tick();
    await settle();
    h.log.length = 0;
    r.tick.tick();
    expect(h.log).toEqual(['attachments', 'outboxRemoval', 'outbox', 'kick', 'sweep']);
  });

  describe('重ならない', () => {
    it('添付が長引く間は添付だけ重ねず、出し箱・kick・sweep は回る。終われば次でまた呼ぶ', async () => {
      const gate = deferred<number>();
      h.attachments = () => gate.promise;
      const r = rig();
      r.tick.tick();
      await settle();
      r.tick.tick();
      await settle();
      expect([count('attachments'), count('outbox'), count('kick'), count('sweep')]).toEqual([
        1, 2, 2, 2,
      ]);
      gate.resolve(0);
      await settle();
      r.tick.tick();
      expect(count('attachments')).toBe(2);
    });

    it('出し箱が長引く間は出し箱だけ重ねず、添付・kick・sweep は回る。終われば次でまた呼ぶ', async () => {
      const gate = deferred<void>();
      h.outbox = () => gate.promise;
      const r = rig();
      r.tick.tick();
      await settle();
      r.tick.tick();
      await settle();
      expect([count('attachments'), count('outbox'), count('kick'), count('sweep')]).toEqual([
        2, 1, 2, 2,
      ]);
      expect(count('outboxRemoval')).toBe(1);
      gate.resolve();
      await settle();
      r.tick.tick();
      expect(count('outbox')).toBe(2);
    });

    it('sweep が長引く間は sweep だけ重ねず、添付・出し箱・kick は回る。終われば次でまた掃く', async () => {
      const gate = deferred<unknown>();
      const r = rig();
      r.set.sweep = () => gate.promise;
      r.tick.tick();
      await settle();
      r.tick.tick();
      await settle();
      expect([count('attachments'), count('outbox'), count('kick'), count('sweep')]).toEqual([
        2, 2, 2, 1,
      ]);
      gate.resolve(null);
      await settle();
      r.tick.tick();
      expect(count('sweep')).toBe(2);
    });
  });

  describe('失敗を握る', () => {
    it('添付が失敗しても握り（unhandled なし）、次の tick でまた呼ぶ', async () => {
      h.attachments = () => Promise.reject(new Error('添付が落ちた'));
      const r = rig();
      r.tick.tick();
      await settle();
      r.tick.tick();
      expect(count('attachments')).toBe(2);
    });

    it('出し箱が失敗しても握り、次の tick でまた呼ぶ', async () => {
      h.outbox = () => Promise.reject(new Error('出し箱が落ちた'));
      const r = rig();
      r.tick.tick();
      await settle();
      r.tick.tick();
      expect(count('outbox')).toBe(2);
    });

    it('sweep が失敗しても握り、emit せず、次の tick でまた掃く', async () => {
      const r = rig();
      r.set.sweep = () => Promise.reject(new Error('掃きが落ちた'));
      r.tick.tick();
      await settle();
      r.tick.tick();
      expect(count('sweep')).toBe(2);
      expect(r.emitted).toEqual([]);
    });
  });

  describe('abort', () => {
    it('abort 済みなら sweep しない。添付・出し箱・kick はその前に呼ぶ（早期 return は 4 つ目の前）', () => {
      const r = rig();
      r.abort.abort();
      r.tick.tick();
      expect(h.log).toEqual(['attachments', 'outboxRemoval', 'outbox', 'kick']);
    });

    it('abort 済みで sweep を飛ばした後も、sweep が走っていないので #scratchRunning は付かない（次に abort が無ければ掃く）', () => {
      // abort は戻せないので、別の rig で「走っていない」ことだけ確かめる: 1 回目で abort → 2 回目も sweep は 0 件
      const r = rig();
      r.abort.abort();
      r.tick.tick();
      r.tick.tick();
      expect(count('sweep')).toBe(0);
    });

    it('sweep の結果が event なら emit、null なら emit しない', async () => {
      const r = rig();
      r.set.sweep = () => Promise.resolve(null);
      r.tick.tick();
      await settle();
      expect(r.emitted).toEqual([]);
      r.set.sweep = () => Promise.resolve(sweepEvent);
      r.tick.tick();
      await settle();
      expect(r.emitted).toEqual([sweepEvent]);
    });

    it('sweep の途中で abort したら、結果が届いても emit しない', async () => {
      const gate = deferred<unknown>();
      const r = rig();
      r.set.sweep = () => gate.promise;
      r.tick.tick();
      r.abort.abort();
      gate.resolve(sweepEvent);
      await settle();
      expect(r.emitted).toEqual([]);
    });

    it('scratchAbort は参照のまま使う: 渡した AbortController が abort されると、次の tick は sweep しない', () => {
      const r = rig();
      r.tick.tick();
      expect(r.sweepCalls[0]?.signal).toBe(r.abort.signal);
      r.abort.abort();
      h.log.length = 0;
      r.tick.tick();
      expect(h.log).not.toContain('sweep');
    });
  });

  describe('口が同期で投げたときの伝わり方（握らない。それ以降は呼ばない）', () => {
    it('添付の関数が同期で投げたら tick から伝わり、出し箱・kick・sweep は呼ばない。次の tick もまた添付から始まる（ガードは付かない）', () => {
      h.attachmentsThrow = new Error('添付が同期で落ちた');
      const r = rig();
      expect(() => r.tick.tick()).toThrow('添付が同期で落ちた');
      expect(h.log).toEqual(['attachments']);
      expect(() => r.tick.tick()).toThrow('添付が同期で落ちた');
      expect(count('attachments')).toBe(2);
    });

    it('sessionKeys が投げたら tick から伝わり、添付の関数は呼ばない', () => {
      const r = rig();
      r.set.sessionKeysThrow = new Error('一覧が落ちた');
      expect(() => r.tick.tick()).toThrow('一覧が落ちた');
      expect(h.log).toEqual([]);
    });

    it('出し箱の関数が同期で投げたら伝わり、添付は呼ばれた後で、kick・sweep は呼ばない。次の tick で添付は重ならず（先の掃除は握られた）呼び直す', async () => {
      h.outboxThrow = new Error('出し箱が同期で落ちた');
      const r = rig();
      expect(() => r.tick.tick()).toThrow('出し箱が同期で落ちた');
      expect(h.log).toEqual(['attachments', 'outboxRemoval', 'outbox']);
      await settle();
      h.log.length = 0;
      h.outboxThrow = undefined;
      r.tick.tick();
      expect(h.log).toEqual(['attachments', 'outboxRemoval', 'outbox', 'kick', 'sweep']);
    });

    it('outboxRemoval が投げたら伝わり、出し箱の関数・kick・sweep は呼ばない', () => {
      const r = rig();
      r.set.outboxRemovalThrow = new Error('設定が落ちた');
      expect(() => r.tick.tick()).toThrow('設定が落ちた');
      expect(h.log).toEqual(['attachments']);
    });

    it('kickMcpConfigSweep が投げたら伝わり、sweep は呼ばない（添付・出し箱は呼ばれた後）', () => {
      const r = rig();
      r.set.kickThrow = new Error('kick が落ちた');
      expect(() => r.tick.tick()).toThrow('kick が落ちた');
      expect(h.log).toEqual(['attachments', 'outboxRemoval', 'outbox', 'kick']);
    });

    it('sweeper.sweep が同期で投げたら伝わり、#scratchRunning は付かない（次の tick でまた掃く）', () => {
      const r = rig();
      r.set.sweepThrow = new Error('sweep が同期で落ちた');
      expect(() => r.tick.tick()).toThrow('sweep が同期で落ちた');
      r.set.sweepThrow = undefined;
      r.tick.tick();
      expect(count('sweep')).toBe(2);
    });

    it('emit が投げても握る（掃きの鎖の .catch）。次の tick でまた掃く', async () => {
      const r = rig();
      r.set.emitThrow = new Error('emit が落ちた');
      r.set.sweep = () => Promise.resolve(sweepEvent);
      r.tick.tick();
      await settle();
      r.tick.tick();
      expect(count('sweep')).toBe(2);
      expect(count('emit')).toBe(1);
    });
  });
});
