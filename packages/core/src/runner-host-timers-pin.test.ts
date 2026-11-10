import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PeerSocketHost } from './peer-socket-host.js';
import type { ProfileVessel } from './profile.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

// `runner.ts` の `Host.constructor` から「scratch タイマー本体」などの起こす部分を切り出す前の、固定（pin）。
// 期待の値は今の作りの出力から `vitest -u` で生成して目で読んで確かめたもの（仕様を先に書いたものではない）。
// 既存の縛りは scratch 3（`runner-scratch-sweep`・`runner-attachments-host`）・lease 6（`runner-fence`）・rescue（`runner-rescue-ref`）・
// shutdown 1（`runner-shutdown-cleanup`）だけで、次は直接の試験が無かった:
//   codexAuthTimer の既定・上書き・unref / scratch の 1 周期の呼び順・重ならない・失敗を握る・abort 後の emit /
//   scratchSweep:false・sweepMcpConfigOnStart / peer の初期判定 / announced の 3 つ / shutdown の 4 本のタイマーの停止。
// 時計はフェイクのタイマー（`vi.useFakeTimers`。`setInterval`・`clearInterval`・`Date` だけ）。実時間は待たない。
// 実 I/O（`pruneStaleAttachmentDirs`・`pruneStaleOutboxRoots`・`ScratchSweeper`・`sweepRunnerMcpConfigDirs`・`CodexAuthMirror`・
// `createProfileApplier`・`runRescue`）は `vi.mock` の偽物。偽物の戻りは自分で握った Promise なので、非同期の待ちは「微小タスクを回す」だけで決まる。

const h = vi.hoisted(() => {
  const defaults = () => ({
    attachments: (): Promise<number> => Promise.resolve(0),
    outbox: (): Promise<void> => Promise.resolve(),
    mcp: (): Promise<{
      removed: string[];
      failed: { name: string; reason: string }[];
      scanError?: string;
    }> => Promise.resolve({ removed: [], failed: [] }),
    sweep: (): Promise<unknown> => Promise.resolve(null),
    codexCheck: (): Promise<void> => Promise.resolve(),
  });
  return {
    log: [] as string[],
    defaults,
    next: defaults(),
    attachmentCalls: [] as unknown[][],
    outboxCalls: [] as unknown[][],
    mcpCalls: [] as Record<string, unknown>[],
    sweeperOptions: [] as Record<string, unknown>[],
    sweepCalls: [] as { signal: AbortSignal; runnerId: string }[],
    rescueCalls: [] as { cwd: string; managerId: string }[],
    codexOptions: [] as Record<string, unknown>[],
    codexPlaced: { value: false },
    profileEnv: {} as Record<string, string>,
    profileApplierOptions: [] as Record<string, unknown>[],
  };
});

vi.mock('./runner-attachments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runner-attachments.js')>()),
  pruneStaleAttachmentDirs: (...args: unknown[]) => {
    h.log.push('attachments');
    h.attachmentCalls.push(args);
    return h.next.attachments();
  },
}));

vi.mock('./runner-outbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runner-outbox.js')>()),
  pruneStaleOutboxRoots: (...args: unknown[]) => {
    h.log.push('outbox');
    h.outboxCalls.push(args);
    return h.next.outbox();
  },
}));

vi.mock('./runner-mcp-config-sweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runner-mcp-config-sweep.js')>()),
  sweepRunnerMcpConfigDirs: (options: Record<string, unknown>) => {
    h.log.push('mcpConfigSweep');
    h.mcpCalls.push(options);
    return h.next.mcp();
  },
}));

vi.mock('./scratch-sweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scratch-sweep.js')>()),
  ScratchSweeper: class {
    constructor(options: Record<string, unknown>) {
      h.sweeperOptions.push(options);
    }
    sweep(signal: AbortSignal, runnerId: string): Promise<unknown> {
      h.log.push('sweep');
      h.sweepCalls.push({ signal, runnerId });
      return h.next.sweep();
    }
  },
}));

vi.mock('./rescue-ref.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rescue-ref.js')>()),
  runRescue: (cwd: string, options: { managerId: string }) => {
    h.log.push('rescue');
    h.rescueCalls.push({ cwd, managerId: options.managerId });
    return Promise.resolve([]);
  },
}));

vi.mock('./codex-auth-mirror.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-auth-mirror.js')>()),
  CodexAuthMirror: class {
    constructor(options: Record<string, unknown>) {
      h.codexOptions.push(options);
    }
    status() {
      return { placed: h.codexPlaced.value, revision: null, fingerprint: null };
    }
    check(): Promise<void> {
      h.log.push('codexCheck');
      return h.next.codexCheck();
    }
    set(): Promise<void> {
      return Promise.resolve();
    }
    prepare(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    }
    takeWriteBack(): null {
      return null;
    }
    reportFailure(): void {}
  },
}));

vi.mock('./profile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./profile.js')>()),
  createProfileApplier: (options: Record<string, unknown>) => {
    h.log.push('createProfileApplier');
    h.profileApplierOptions.push(options);
    return {
      vessel: options.vessel,
      fingerprint: () => ({ sha256: 'fp-fake', bytes: 1, updatedAt: 't' }),
      env: () => ({ ...h.profileEnv }),
      apply: () => Promise.resolve({ ok: true }),
      prepare: () =>
        Promise.resolve({
          ok: true,
          commit: () => Promise.resolve(undefined),
          discard: () => Promise.resolve(),
        }),
    };
  },
}));

function fakeSdk(): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-pin',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt) void message;
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

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

/** 偽物の Promise の連鎖（`.catch().then().finally()`）が落ち着くまで、macrotask を何度か譲る。時間は進めない。 */
async function settleTurns(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 出るまで回数の上限つきで回す（実 I/O を待つ箇所用: start・shutdown）。 */
async function until(condition: () => boolean, maxTurns = 5000): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('条件が満たされなかった');
}

function count(label: string): number {
  return h.log.filter((entry) => entry === label).length;
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
// 4 本のタイマーを間隔で見分ける（lease の間隔は `LEASE_WATCH_INTERVAL_MS` = 10_000 で固定）
const CODEX_MS = 1_000_000;
const RESCUE_MS = 2_000_000;
const SCRATCH_MS = 5_000;
const LEASE_MS = 10_000;

interface TimerRecord {
  ms: number;
  unref: ReturnType<typeof vi.spyOn>;
}

describe('Host.constructor のタイマーと起動順の固定', () => {
  let tmp: string;
  let hosts: RunnerHost[] = [];
  let current: RunnerHost | undefined;
  let timers: TimerRecord[] = [];
  let cleared: number[] = [];
  let restoreTimerSpy: () => void = () => undefined;

  function installTimerSpy(): void {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const byHandle = new Map<unknown, number>();
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const handle = realSet(fn, ms);
      byHandle.set(handle, ms);
      timers.push({ ms, unref: vi.spyOn(handle, 'unref') });
      return handle;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      cleared.push(byHandle.get(handle) ?? -1);
      realClear(handle);
    }) as typeof clearInterval;
    restoreTimerSpy = () => {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    };
  }

  beforeEach(async () => {
    tmp = await makeTempDir('runner-host-timers-pin-');
    for (const dir of ['att', 'outbox', 'staged', 'rescue', 'mcp']) {
      await mkdir(path.join(tmp, dir));
    }
    h.log.length = 0;
    h.next = h.defaults();
    h.attachmentCalls.length = 0;
    h.outboxCalls.length = 0;
    h.mcpCalls.length = 0;
    h.sweeperOptions.length = 0;
    h.sweepCalls.length = 0;
    h.rescueCalls.length = 0;
    h.codexOptions.length = 0;
    h.codexPlaced.value = false;
    h.profileEnv = {};
    h.profileApplierOptions.length = 0;
    timers = [];
    cleared = [];
    current = undefined;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    installTimerSpy();
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
    hosts = [];
    restoreTimerSpy();
    vi.useRealTimers();
    await rm(tmp, { recursive: true, force: true });
  });

  /** 既定の口（間隔は互いに違う値。実 I/O の根は tmp）を足さない素の組み立て。 */
  function raw(options: Partial<RunnerHostOptions> = {}): {
    host: RunnerHost;
    events: RunnerEvent[];
  } {
    const events: RunnerEvent[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-pin',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fakeSdk(),
      env: { PATH: '/usr/bin' },
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
      cwdExistsFn: () => true,
      attachmentsRoot: path.join(tmp, 'att'),
      outboxRoot: path.join(tmp, 'outbox'),
      outboxStagedRoot: path.join(tmp, 'staged'),
      rescueStagedRoot: path.join(tmp, 'rescue'),
      mcpConfigTmpRoot: path.join(tmp, 'mcp'),
      ...options,
    });
    hosts.push(host);
    current = host;
    return { host, events };
  }

  function build(options: Partial<RunnerHostOptions> = {}): {
    host: RunnerHost;
    events: RunnerEvent[];
  } {
    return raw({
      codexAuthCheckIntervalMs: CODEX_MS,
      rescueIntervalMs: RESCUE_MS,
      scratchSweep: { intervalMs: SCRATCH_MS, tmpRoot: '/scratch-pin', graceMs: 111 },
      ...options,
    });
  }

  async function startSessions(host: RunnerHost, ids: readonly string[]): Promise<void> {
    for (const managerId of ids) {
      await host.start({ managerId, request: '依頼', cwd: '/work/project' });
    }
    // 起こす側の副作用（退避など）を数えない
    await settleTurns();
    h.log.length = 0;
    h.rescueCalls.length = 0;
  }

  async function tick(periods = 1, ms = SCRATCH_MS): Promise<void> {
    for (let i = 0; i < periods; i += 1) {
      vi.advanceTimersByTime(ms);
      await settleTurns();
    }
  }

  describe('scratch タイマーの 1 周期', () => {
    it('添付 → 出し箱 → MCP 設定 → scratch の順に、同じ tick の中で（await を待たずに）呼ぶ。渡す値も固定', async () => {
      h.next.attachments = () => new Promise(() => undefined);
      h.next.outbox = () => new Promise(() => undefined);
      h.next.mcp = () => new Promise(() => undefined);
      h.next.sweep = () => new Promise(() => undefined);
      const removal = vi.fn();
      const { host } = build({ outboxRemoveContentsAsChild: removal });
      await startSessions(host, ['mgr-aaaa1111', 'mgr-bbbb2222']);

      // 同期の advance: 非同期の待ちを一度も挟まないので、4 つがこの 1 回の呼び出しの中で呼ばれたことになる
      vi.advanceTimersByTime(SCRATCH_MS);
      expect(h.log).toEqual(['attachments', 'outbox', 'mcpConfigSweep', 'sweep']);

      const now = T0.getTime() + SCRATCH_MS;
      expect(h.attachmentCalls).toEqual([
        [path.join(tmp, 'att'), ['mgr-aaaa1111', 'mgr-bbbb2222'], now],
      ]);
      const [roots, liveIds, outboxNow, removalOptions] = h.outboxCalls[0] as [
        unknown,
        () => string[],
        number,
        unknown,
      ];
      expect(roots).toEqual({
        outboxRoot: path.join(tmp, 'outbox'),
        stagedRoot: path.join(tmp, 'staged'),
        rescueStagedRoot: path.join(tmp, 'rescue'),
      });
      expect(liveIds()).toEqual(['mgr-aaaa1111', 'mgr-bbbb2222']);
      expect(outboxNow).toBe(now);
      expect(removalOptions).toEqual({ removeContentsAsChild: removal });
      expect(h.mcpCalls).toHaveLength(1);
      expect(h.mcpCalls[0]).toMatchObject({ tmpRoot: path.join(tmp, 'mcp'), now });
      expect(h.mcpCalls[0]?.liveDirs).toBeInstanceOf(Set);
      expect(h.sweepCalls).toHaveLength(1);
      expect(h.sweepCalls[0]?.runnerId).toBe('runner-pin');
      expect(h.sweepCalls[0]?.signal.aborted).toBe(false);
    });

    it('子の権限へ降ろす構成では、出し箱の削除の口に child の uid / gid を渡す', async () => {
      const { host } = build({ childUser: { uid: 1234, gid: 5678 } as never });
      void host;
      await tick();
      const removalOptions = h.outboxCalls[0]?.[3];
      expect(removalOptions).toEqual({ child: { uid: 1234, gid: 5678 } });
    });

    it('scratch の掃きの結果は、null なら出さず、イベントなら emit する', async () => {
      const { events } = build();
      await tick();
      expect(events.filter((e) => e.type === 'scratch_sweep')).toEqual([]);

      const sweepEvent = {
        type: 'scratch_sweep',
        runnerId: 'runner-pin',
        removed: [{ name: 'mgr-aaaa1111', kind: 'directory' }],
        kept: [],
      };
      h.next.sweep = () => Promise.resolve(sweepEvent);
      await tick();
      expect(events.filter((e) => e.type === 'scratch_sweep')).toEqual([sweepEvent]);
    });
  });

  describe('重ならない・失敗を握る', () => {
    it('添付の掃除が長引く間は添付だけ重ねず、出し箱・MCP・scratch は周期ごとに回る（鎖に乗らない）', async () => {
      const held = deferred<number>();
      h.next.attachments = () => held.promise;
      build();
      await tick(2);
      expect(count('attachments')).toBe(1);
      expect(count('outbox')).toBe(2);
      expect(count('mcpConfigSweep')).toBe(2);
      expect(count('sweep')).toBe(2);

      // 終わる（finally で null に戻る）と次の周期でまた呼ぶ
      held.resolve(3);
      await settleTurns();
      await tick();
      expect(count('attachments')).toBe(2);
    });

    it('添付の掃除が失敗しても握り（.catch）、次の周期でまた呼ぶ', async () => {
      const held = deferred<number>();
      h.next.attachments = () => held.promise;
      build();
      await tick();
      held.reject(new Error('添付の掃除の失敗'));
      await settleTurns();
      h.next.attachments = () => Promise.resolve(0);
      await tick();
      expect(count('attachments')).toBe(2);
    });

    it('出し箱の掃除が長引く間は出し箱だけ重ねず、添付・MCP・scratch は回る。終われば次の周期でまた呼ぶ', async () => {
      const held = deferred<void>();
      h.next.outbox = () => held.promise;
      build();
      await tick(2);
      expect(count('outbox')).toBe(1);
      expect(count('attachments')).toBe(2);
      expect(count('mcpConfigSweep')).toBe(2);
      expect(count('sweep')).toBe(2);

      held.resolve();
      await settleTurns();
      await tick();
      expect(count('outbox')).toBe(2);
    });

    it('出し箱の掃除が失敗しても握り、次の周期でまた呼ぶ', async () => {
      const held = deferred<void>();
      h.next.outbox = () => held.promise;
      build();
      await tick();
      held.reject(new Error('出し箱の掃除の失敗'));
      await settleTurns();
      h.next.outbox = () => Promise.resolve();
      await tick();
      expect(count('outbox')).toBe(2);
    });

    it('scratch の掃きが長引く間は重ねず、添付・出し箱・MCP は回る。終われば次の周期でまた掃く', async () => {
      const held = deferred<unknown>();
      h.next.sweep = () => held.promise;
      build();
      await tick(2);
      expect(count('sweep')).toBe(1);
      expect(count('attachments')).toBe(2);
      expect(count('outbox')).toBe(2);
      expect(count('mcpConfigSweep')).toBe(2);

      held.resolve(null);
      await settleTurns();
      await tick();
      expect(count('sweep')).toBe(2);
    });

    it('scratch の掃きが失敗しても握り、emit せず、次の周期でまた掃く', async () => {
      const held = deferred<unknown>();
      h.next.sweep = () => held.promise;
      const { events } = build();
      await tick();
      held.reject(new Error('掃きの失敗'));
      await settleTurns();
      h.next.sweep = () => Promise.resolve(null);
      await tick();
      expect(count('sweep')).toBe(2);
      expect(events.filter((e) => e.type === 'scratch_sweep')).toEqual([]);
    });

    it('MCP 設定の掃きが続く間は重ねない。終われば次の周期でまた起こす（scratch の掃きの鎖には乗らない）', async () => {
      const held = deferred<{ removed: string[]; failed: { name: string; reason: string }[] }>();
      h.next.mcp = () => held.promise;
      build();
      await tick(2);
      expect(count('mcpConfigSweep')).toBe(1);
      expect(count('sweep')).toBe(2);

      held.resolve({ removed: [], failed: [] });
      await settleTurns();
      await tick();
      expect(count('mcpConfigSweep')).toBe(2);
    });
  });

  describe('#scratchAbort', () => {
    it('走行中の掃きの結果は、shutdown（abort）の後に返っても emit しない', async () => {
      const held = deferred<unknown>();
      h.next.sweep = () => held.promise;
      const { host, events } = build();
      await tick();
      const sweepEvent = { type: 'scratch_sweep', runnerId: 'runner-pin', removed: [], kept: [] };
      const closing = host.shutdown();
      // `shutdown` の同期の部分で abort 済み（セッションの停止の await より前）
      expect(h.sweepCalls[0]?.signal.aborted).toBe(true);
      held.resolve(sweepEvent);
      await closing;
      await settleTurns();
      expect(events.filter((e) => e.type === 'scratch_sweep')).toEqual([]);
    });

    it('MCP 設定の掃きの結果も、abort の後に返れば emit しない', async () => {
      const held = deferred<{ removed: string[]; failed: { name: string; reason: string }[] }>();
      h.next.mcp = () => held.promise;
      const { host, events } = build();
      await tick();
      const closing = host.shutdown();
      held.resolve({ removed: ['mcp-config-x'], failed: [] });
      await closing;
      await settleTurns();
      expect(events.filter((e) => e.type === 'scratch_sweep')).toEqual([]);
    });

    it('MCP 設定の掃きの結果は、abort 前なら scratch_sweep で emit する', async () => {
      h.next.mcp = () => Promise.resolve({ removed: ['mcp-config-x'], failed: [] });
      const { events } = build();
      await tick();
      expect(events.filter((e) => e.type === 'scratch_sweep')).toMatchInlineSnapshot(`
        [
          {
            "kept": [],
            "removed": [
              {
                "kind": "directory",
                "name": "mcp-config-x",
              },
            ],
            "runnerId": "runner-pin",
            "type": "scratch_sweep",
          },
        ]
      `);
    });
  });

  describe('scratchSweep の有無・起動時の掃き・上書き', () => {
    it('scratchSweep: false ならタイマーを作らず（ScratchSweeper も作らず）、周期を進めても何も呼ばない', async () => {
      build({ scratchSweep: false });
      expect(timers.map((t) => t.ms)).toEqual([CODEX_MS, RESCUE_MS]);
      expect(h.sweeperOptions).toEqual([]);
      await tick(5);
      expect(h.log.filter((entry) => entry !== 'codexCheck')).toEqual([]);
    });

    it('scratchSweep が false でなければ（既定も）タイマーを作る', () => {
      build({ scratchSweep: { intervalMs: SCRATCH_MS } });
      expect(timers.map((t) => t.ms)).toEqual([CODEX_MS, RESCUE_MS, SCRATCH_MS]);
      expect(h.sweeperOptions).toHaveLength(1);
    });

    it('sweepMcpConfigOnStart: true は constructor のうちに 1 回（最初の周期より前に）起こす', () => {
      build({ sweepMcpConfigOnStart: true });
      expect(h.log).toEqual(['mcpConfigSweep']);
      expect(h.mcpCalls[0]).toMatchObject({ tmpRoot: path.join(tmp, 'mcp'), now: T0.getTime() });
    });

    it('sweepMcpConfigOnStart が false・未指定なら起動時には呼ばない（最初の周期で初めて呼ぶ）', async () => {
      build({ sweepMcpConfigOnStart: false });
      build();
      expect(h.log).toEqual([]);
      await tick();
      expect(count('mcpConfigSweep')).toBe(2);
    });

    it('scratchSweep: false なら sweepMcpConfigOnStart: true でも起動時の掃きは無い', () => {
      build({ scratchSweep: false, sweepMcpConfigOnStart: true });
      expect(h.log).toEqual([]);
    });

    it('ScratchSweeper へ渡す値: 上書きは scratchSweep の値が勝ち、起動時刻・生きた担当・既知の担当の口を持つ', async () => {
      const { host } = build({
        scratchSweep: { intervalMs: SCRATCH_MS, tmpRoot: '/over', graceMs: 7 },
      });
      await startSessions(host, ['mgr-aaaa1111']);
      const options = h.sweeperOptions[0] as {
        tmpRoot: string;
        graceMs: number;
        startedAt: number;
        spawn: unknown;
        env: Record<string, string | undefined>;
        liveManagerIds: () => string[];
        knownManagerIds: () => string[];
      };
      expect(options.tmpRoot).toBe('/over');
      expect(options.graceMs).toBe(7);
      expect(options.startedAt).toBe(T0.getTime());
      expect(typeof options.spawn).toBe('function');
      expect(options.liveManagerIds()).toEqual(['mgr-aaaa1111']);
      expect([...options.knownManagerIds()]).toMatchInlineSnapshot(`
        [
          "mgr-aaaa1111",
        ]
      `);
      expect(options.env.PATH).toBe('/usr/bin');
      expect(Object.keys(options).sort()).toMatchInlineSnapshot(`
        [
          "env",
          "graceMs",
          "knownManagerIds",
          "liveManagerIds",
          "spawn",
          "startedAt",
          "tmpRoot",
        ]
      `);
    });

    it('既定: tmpRoot は /tmp、猶予・間隔は env（ALTEROID_SCRATCH_SWEEP_*）から読み、無ければ既定値', () => {
      raw({ scratchSweep: {}, env: { PATH: '/usr/bin' } });
      const fallback = h.sweeperOptions[0] as { tmpRoot: string; graceMs: number };
      expect(fallback.tmpRoot).toBe('/tmp');
      expect({ graceMs: fallback.graceMs, ms: timers.map((t) => t.ms) }).toMatchInlineSnapshot(`
        {
          "graceMs": 7200000,
          "ms": [
            60000,
            300000,
            600000,
          ],
        }
      `);
    });

    it('env から読む: 猶予と間隔', () => {
      raw({
        env: {
          PATH: '/usr/bin',
          ALTEROID_SCRATCH_SWEEP_GRACE_MS: '123456',
          ALTEROID_SCRATCH_SWEEP_INTERVAL_MS: '54321',
        },
      });
      const options = h.sweeperOptions[0] as { graceMs: number };
      expect({ graceMs: options.graceMs, ms: timers.map((t) => t.ms) }).toMatchInlineSnapshot(`
        {
          "graceMs": 123456,
          "ms": [
            60000,
            300000,
            54321,
          ],
        }
      `);
    });

    it('scratchSweep.intervalMs は env より優先する', () => {
      raw({
        env: { PATH: '/usr/bin', ALTEROID_SCRATCH_SWEEP_INTERVAL_MS: '54321' },
        scratchSweep: { intervalMs: 4321 },
      });
      expect(timers.map((t) => t.ms)).toContain(4321);
      expect(timers.map((t) => t.ms)).not.toContain(54321);
    });
  });

  describe('codexAuthTimer', () => {
    it('既定は 60_000ms ごとに check()。上書きの間隔ならそちらで呼ぶ', async () => {
      raw({ scratchSweep: false, rescueIntervalMs: RESCUE_MS });
      expect(timers[0]?.ms).toBe(60_000);
      vi.advanceTimersByTime(59_999);
      expect(count('codexCheck')).toBe(0);
      vi.advanceTimersByTime(1);
      expect(count('codexCheck')).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(count('codexCheck')).toBe(2);
    });

    it('codexAuthCheckIntervalMs で間隔を上書きする', () => {
      raw({ scratchSweep: false, rescueIntervalMs: RESCUE_MS, codexAuthCheckIntervalMs: 1_000 });
      expect(timers[0]?.ms).toBe(1_000);
      vi.advanceTimersByTime(3_000);
      expect(count('codexCheck')).toBe(3);
    });

    it('check() が拒否されても握り、次の周期でまた呼ぶ', async () => {
      h.next.codexCheck = () => Promise.reject(new Error('auth.json を読めない'));
      raw({ scratchSweep: false, rescueIntervalMs: RESCUE_MS, codexAuthCheckIntervalMs: 1_000 });
      vi.advanceTimersByTime(1_000);
      await settleTurns();
      vi.advanceTimersByTime(1_000);
      await settleTurns();
      expect(count('codexCheck')).toBe(2);
    });

    it('4 本のタイマーはどれも unref する（見張りでプロセスの終了を引き延ばさない）', () => {
      build({ enforceLease: true });
      expect(timers.map((t) => t.ms)).toEqual([CODEX_MS, RESCUE_MS, SCRATCH_MS, LEASE_MS]);
      expect(timers.map((t) => t.unref.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });

    it('CodexAuthMirror へ codexHome と onNotice を渡す（子の権限なら owner も）', () => {
      build({ codexHome: '/home/codex-pin', childUser: { uid: 11, gid: 22 } as never });
      const options = h.codexOptions[0] as Record<string, unknown>;
      expect(options.codexHome).toBe('/home/codex-pin');
      expect(options.owner).toEqual({ uid: 11, gid: 22 });
      expect(typeof options.onNotice).toBe('function');
    });
  });

  describe('タイマーの本数と作る順・既定の間隔', () => {
    it('既定: codex 60_000 → rescue（env か既定）→ scratch（env か既定）。enforceLease でなければ lease は無い', () => {
      raw({ env: { PATH: '/usr/bin' } });
      expect(timers.map((t) => t.ms)).toMatchInlineSnapshot(`
        [
          60000,
          300000,
          600000,
        ]
      `);
    });

    it('enforceLease: true なら最後に lease の見張りを 10_000ms で足す', () => {
      raw({ env: { PATH: '/usr/bin' }, enforceLease: true });
      expect(timers.map((t) => t.ms)).toMatchInlineSnapshot(`
        [
          60000,
          300000,
          600000,
          10000,
        ]
      `);
    });

    it('rescue の間隔は env（ALTEROID_RESCUE_INTERVAL_MS）から読み、rescueIntervalMs が勝つ', () => {
      raw({
        scratchSweep: false,
        env: { PATH: '/usr/bin', ALTEROID_RESCUE_INTERVAL_MS: '45000' },
      });
      raw({
        scratchSweep: false,
        env: { PATH: '/usr/bin', ALTEROID_RESCUE_INTERVAL_MS: '45000' },
        rescueIntervalMs: 9000,
      });
      expect(timers.map((t) => t.ms)).toEqual([60_000, 45_000, 60_000, 9_000]);
    });
  });

  describe('rescueTimer', () => {
    it('session が 0 件なら何も撃たない', async () => {
      build({ scratchSweep: false, rescueIntervalMs: 3_000 });
      vi.advanceTimersByTime(9_000);
      await settleTurns();
      expect(h.rescueCalls).toEqual([]);
    });

    it('全 session の rescueRef を周期ごとに撃つ（2 件）', async () => {
      const { host } = build({ scratchSweep: false, rescueIntervalMs: 3_000 });
      await startSessions(host, ['mgr-aaaa1111', 'mgr-bbbb2222']);
      vi.advanceTimersByTime(3_000);
      await settleTurns();
      expect(h.rescueCalls).toEqual([
        { cwd: '/work/project', managerId: 'mgr-aaaa1111' },
        { cwd: '/work/project', managerId: 'mgr-bbbb2222' },
      ]);
      vi.advanceTimersByTime(3_000);
      await settleTurns();
      expect(h.rescueCalls).toHaveLength(4);
    });
  });

  // lease の見張りの中身（期限切れの自己失効）は `runner-fence.test.ts` が縛っている。ここは本数と間隔（上の 2 件・unref・shutdown）だけ。

  describe('peer の初期判定', () => {
    function peerOptions(sockets: string[]): NonNullable<RunnerHostOptions['peer']> {
      return {
        openSocket: () => {
          h.log.push('openSocket');
          sockets.push(JSON.stringify(current?.profile() ?? null));
          return Promise.resolve({ close: () => undefined } as unknown as PeerSocketHost);
        },
        reportsUsage: () => false,
        models: { codex: ['gpt-pin'] },
      };
    }

    it('peer 無しなら名乗る物が無く、ソケットも開かない', async () => {
      const { host } = build();
      expect(host.managerPeers()).toBeUndefined();
      await settleTurns();
      expect(h.log).not.toContain('openSocket');
    });

    it('閉じている側（資格が無い）は constructor のうちに閉じた理由まで名乗れる。ソケットは開かず manager_peers も出さない', async () => {
      const sockets: string[] = [];
      h.codexPlaced.value = false;
      const { host, events } = build({ peer: peerOptions(sockets) });
      expect(host.managerPeers()).toMatchInlineSnapshot(`
        {
          "managerPeers": [],
          "managerPeersClosed": [
            {
              "provider": "codex",
              "reason": "Codex の資格がこの器に届いていない（ChatGPT ログインも CODEX_API_KEY も無い）。人間が Web の「設定 — Codex」か \`alteroid codex login\` でログインするか、\`alteroid credential set CODEX_API_KEY\` で鍵を置くと、再起動なしで開く",
            },
          ],
        }
      `);
      await settleTurns();
      expect(sockets).toEqual([]);
      expect(events.filter((e) => e.type === 'manager_peers')).toEqual([]);
    });

    it('開く側（資格がある）は constructor では開かず、周回の後で開いて manager_peers を出す。その時点で profile は置かれている', async () => {
      const sockets: string[] = [];
      h.codexPlaced.value = true;
      const { host, events } = build({ peer: peerOptions(sockets), profile: {} as ProfileVessel });
      h.log.push('constructed');
      expect(host.managerPeers()).toMatchInlineSnapshot(`
        {
          "managerPeers": [],
        }
      `);
      expect(h.log).toEqual(['createProfileApplier', 'constructed']);
      await until(() => sockets.length > 0);
      await settleTurns();
      expect(h.log).toEqual(['createProfileApplier', 'constructed', 'openSocket']);
      // openSocket が走った時点で #profile は置かれている
      expect(sockets).toMatchInlineSnapshot(`
        [
          "{"sha256":"fp-fake","bytes":1,"updatedAt":"t"}",
        ]
      `);
      expect(host.managerPeers()).toMatchInlineSnapshot(`
        {
          "managerPeers": [
            {
              "models": [
                "gpt-pin",
              ],
              "provider": "codex",
            },
          ],
        }
      `);
      expect(events.filter((e) => e.type === 'manager_peers')).toMatchInlineSnapshot(`
        [
          {
            "managerPeers": [
              {
                "models": [
                  "gpt-pin",
                ],
                "provider": "codex",
              },
            ],
            "runnerId": "runner-pin",
            "type": "manager_peers",
          },
        ]
      `);
    });
  });

  describe('announced の 3 つ（#profile の後に置かれる）', () => {
    const PROFILE_ENV = {
      ANTHROPIC_BASE_URL: 'https://proxy.example.test',
      ALTEROID_BASH_SHAPE_GUARD: 'off',
      ALTEROID_REPORT_LANGUAGE: 'ja',
    };

    it('profile を渡すと createProfileApplier を 1 回呼ぶ（baseEnv の口つき・child 無しなら spawnFn 無し）。渡さなければ呼ばない', () => {
      build();
      expect(h.profileApplierOptions).toEqual([]);
      build({ profile: {} as ProfileVessel });
      expect(h.profileApplierOptions).toHaveLength(1);
      const options = h.profileApplierOptions[0] as Record<string, unknown>;
      expect(Object.keys(options).sort()).toEqual(['baseEnv', 'vessel']);
      expect(typeof (options.baseEnv as () => unknown)()).toBe('object');
    });

    it('子の権限へ降ろす構成では spawnFn も渡す', () => {
      build({ profile: {} as ProfileVessel, childUser: { uid: 11, gid: 22 } as never });
      expect(Object.keys(h.profileApplierOptions[0] as object).sort()).toEqual([
        'baseEnv',
        'spawnFn',
        'vessel',
      ]);
    });

    it('profile ありの値（起動行）は profile の env を含み、無しは runner の env の値', () => {
      h.profileEnv = { ...PROFILE_ENV };
      const withProfile = build({ profile: {} as ProfileVessel }).host;
      const without = build().host;
      expect({
        withProfile: {
          anthropicRoute: withProfile.anthropicRoute(),
          bashShapeGuardLine: withProfile.bashShapeGuardLine(),
          reportLanguageLine: withProfile.reportLanguageLine(),
        },
        without: {
          anthropicRoute: without.anthropicRoute(),
          bashShapeGuardLine: without.bashShapeGuardLine(),
          reportLanguageLine: without.reportLanguageLine(),
        },
      }).toMatchInlineSnapshot(`
        {
          "withProfile": {
            "anthropicRoute": [
              "⚠️ ANTHROPIC_BASE_URL が https://proxy.example.test を指しているが、接続先用の鍵（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）が置かれていない。Claude のログインの鍵（CLAUDE_CODE_OAUTH_TOKEN）がこの接続先へ送られる（いまは置かれていないが、置かれれば送られる）。接続先が Claude の鍵を中継する gateway でないなら、接続先用の鍵を置くこと（settings の apiKeyHelper は見ていない）（#4263）",
              "ANTHROPIC_BASE_URL=https://proxy.example.test（出所: プロファイル）— 送り先が変わっている。別名の先で Claude 以外のモデルが答えうる（#4261）",
            ],
            "bashShapeGuardLine": "Bash の形の歯: off（ALTEROID_BASH_SHAPE_GUARD。実行環境プロファイルの値。runner の env より優先される）",
            "reportLanguageLine": "報告の言語の知らせ: ja（ALTEROID_REPORT_LANGUAGE。実行環境プロファイルの値。runner の env より優先される）",
          },
          "without": {
            "anthropicRoute": [],
            "bashShapeGuardLine": "Bash の形の歯: off（ALTEROID_BASH_SHAPE_GUARD。runner の env の値。実行環境プロファイルに置けばそちらが優先される）",
            "reportLanguageLine": "報告の言語の知らせ: off（ALTEROID_REPORT_LANGUAGE。runner の env の値。実行環境プロファイルに置けばそちらが優先される）",
          },
        }
      `);
    });

    it('起動時に名乗り済みの値は profile の env を含む: 同じ env での setProfile は何も出し直さない', async () => {
      h.profileEnv = { ...PROFILE_ENV };
      const lines: string[] = [];
      const { host, events } = build({
        profile: {} as ProfileVessel,
        log: (line) => lines.push(line),
      });
      expect(lines).toEqual([]);
      await host.setProfile('export X=1');
      expect(events.filter((e) => e.type === 'anthropic_route')).toEqual([]);
      expect(lines).toEqual([]);
    });

    it('実効の値が変わった setProfile は、3 つとも出し直す（anthropic_route の出来事と 2 行のログ）', async () => {
      h.profileEnv = { ...PROFILE_ENV };
      const lines: string[] = [];
      const { host, events } = build({
        profile: {} as ProfileVessel,
        log: (line) => lines.push(line),
      });
      h.profileEnv = {
        ANTHROPIC_BASE_URL: 'https://other.example.test',
        ALTEROID_BASH_SHAPE_GUARD: 'on',
        ALTEROID_REPORT_LANGUAGE: 'off',
      };
      await host.setProfile('export X=2');
      expect({
        events: events.filter((e) => e.type === 'anthropic_route'),
        lines,
      }).toMatchInlineSnapshot(`
        {
          "events": [
            {
              "anthropicRoute": [
                "⚠️ ANTHROPIC_BASE_URL が https://other.example.test を指しているが、接続先用の鍵（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）が置かれていない。Claude のログインの鍵（CLAUDE_CODE_OAUTH_TOKEN）がこの接続先へ送られる（いまは置かれていないが、置かれれば送られる）。接続先が Claude の鍵を中継する gateway でないなら、接続先用の鍵を置くこと（settings の apiKeyHelper は見ていない）（#4263）",
                "ANTHROPIC_BASE_URL=https://other.example.test（出所: プロファイル）— 送り先が変わっている。別名の先で Claude 以外のモデルが答えうる（#4261）",
              ],
              "runnerId": "runner-pin",
              "type": "anthropic_route",
            },
          ],
          "lines": [
            "alteroid-runner: Bash の形の歯: on（ALTEROID_BASH_SHAPE_GUARD。実行環境プロファイルの値。runner の env より優先される）",
            "alteroid-runner: 報告の言語の知らせ: off（ALTEROID_REPORT_LANGUAGE。実行環境プロファイルの値。runner の env より優先される）",
          ],
        }
      `);
    });

    it('profile 無しなら setProfile は器が無いと断る（起動時の名乗りも出さない）', async () => {
      const lines: string[] = [];
      const { host } = build({ log: (line) => lines.push(line) });
      await expect(host.setProfile('x')).rejects.toThrow('プロファイルの器が無い runner');
      expect(lines).toEqual([]);
    });
  });

  describe('shutdown が 4 本のタイマーを止める', () => {
    it('lease → rescue → scratch → codex の順に止め、タイマーは 0 本になる。同期の部分（セッションの停止を待つ前）で終わる', async () => {
      const { host } = build({ enforceLease: true });
      expect(vi.getTimerCount()).toBe(4);
      const closing = host.shutdown();
      expect(cleared).toEqual([LEASE_MS, RESCUE_MS, SCRATCH_MS, CODEX_MS]);
      expect(vi.getTimerCount()).toBe(0);
      await closing;
    });

    it('scratchSweep: false・enforceLease: false なら、その分は止めない（rescue → codex だけ）', async () => {
      const { host } = build({ scratchSweep: false });
      expect(vi.getTimerCount()).toBe(2);
      await host.shutdown();
      expect(cleared).toEqual([RESCUE_MS, CODEX_MS]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('止めた後に周期を進めても何も呼ばれない', async () => {
      const { host } = build({ enforceLease: true });
      await host.shutdown();
      h.log.length = 0;
      vi.advanceTimersByTime(RESCUE_MS * 3);
      await settleTurns();
      expect(h.log).toEqual([]);
    });

    it('scratch の掃きが走っている途中でも、その完了を待たずに返る（abort するだけ）', async () => {
      const held = deferred<unknown>();
      h.next.sweep = () => held.promise;
      const { host } = build();
      await tick();
      let done = false;
      void host.shutdown().then(() => {
        done = true;
      });
      await until(() => done);
      expect(h.sweepCalls[0]?.signal.aborted).toBe(true);
      held.resolve(null);
    });

    it('畳み始めの名乗り（shutting_down）はタイマーを止める前に出す', async () => {
      const order: string[] = [];
      const { host } = build({
        emit: (event) => order.push(event.type),
      });
      const real = globalThis.clearInterval;
      globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
        order.push('clearInterval');
        real(handle);
      }) as typeof clearInterval;
      try {
        await host.shutdown();
      } finally {
        globalThis.clearInterval = real;
      }
      expect(order.slice(0, 2)).toEqual(['shutting_down', 'clearInterval']);
    });
  });
});
