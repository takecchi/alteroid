import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, PEER_PARK_TTL_MS, type RunnerHost } from './runner.js';

type CapturedSession = { options: Options };

function fakeSdk(sessions: CapturedSession[] = []): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.push({ options: params.options ?? {} });
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
        }
      })();
      await closed;
    }

    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

// 'exit' 用と 'error' 用の配列を分ける: 共有の緩い型の配列だと、SDK の宣言どおりのオーバーロードと実装の型が噛み合わないため
class FakeDelegationProcess {
  readonly pid: number | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly killed = false;
  readonly exitCode: number | null = null;
  readonly #exitListeners: ExitListener[] = [];
  readonly #errorListeners: ErrorListener[] = [];

  constructor(pid: number | undefined) {
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }

  on(event: 'exit', listener: ExitListener): void;
  on(event: 'error', listener: ErrorListener): void;
  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    if (event === 'exit') this.#exitListeners.push(listener as ExitListener);
    else this.#errorListeners.push(listener as ErrorListener);
  }

  once(event: 'exit', listener: ExitListener): void;
  once(event: 'error', listener: ErrorListener): void;
  once(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    if (event === 'exit') {
      const exitListener = listener as ExitListener;
      const wrapped: ExitListener = (code, signal) => {
        this.off('exit', wrapped);
        exitListener(code, signal);
      };
      this.on('exit', wrapped);
    } else {
      const errorListener = listener as ErrorListener;
      const wrapped: ErrorListener = (error) => {
        this.off('error', wrapped);
        errorListener(error);
      };
      this.on('error', wrapped);
    }
  }

  off(event: 'exit', listener: ExitListener): void;
  off(event: 'error', listener: ErrorListener): void;
  off(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    if (event === 'exit') {
      const idx = this.#exitListeners.indexOf(listener as ExitListener);
      if (idx !== -1) this.#exitListeners.splice(idx, 1);
    } else {
      const idx = this.#errorListeners.indexOf(listener as ErrorListener);
      if (idx !== -1) this.#errorListeners.splice(idx, 1);
    }
  }

  emitExit(): void {
    for (const listener of [...this.#exitListeners]) listener(0, null);
  }

  emitError(): void {
    for (const listener of [...this.#errorListeners]) {
      listener(new Error('spawn failed（テストの偽物）'));
    }
  }
}

function fakeDelegationProcess(pid: number | undefined): {
  handle: FakeDelegationProcess;
  emitExit: () => void;
  emitError: () => void;
} {
  const handle = new FakeDelegationProcess(pid);
  return { handle, emitExit: () => handle.emitExit(), emitError: () => handle.emitError() };
}

// 3つ目の集合 `ownerListed`（#5157。観測の内訳用）が増えても、`live` / `knownTerminated` の期待値を1文字も変えないための絞り込み
function liveAndTerminatedOf(host: RunnerHost): {
  live: ReadonlySet<number>;
  knownTerminated: ReadonlySet<number>;
} {
  const { live, knownTerminated } = host.delegationSessionPids();
  return { live, knownTerminated };
}

describe('委譲のセッション pid 追跡（#1334 段1。host.delegationSessionPids()）', () => {
  it('起きたら live へ。exit しても、委譲(managerId)自身が runner に残っていれば knownTerminated へは移らない', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(4242);

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });

    expect(liveAndTerminatedOf(host)).toEqual({ live: new Set(), knownTerminated: new Set() });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    expect(sessions).toHaveLength(1);
    const { options } = sessions[0] as CapturedSession;
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');

    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([4242]),
      knownTerminated: new Set(),
    });

    fake.emitExit();

    // exit では knownTerminated へ入れない: 委譲が生きたままだと、nohup 等で残った子孫が孤児回収で撃たれる
    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });

  it('起こす前に失敗しても（error）、委譲自身が runner に残っていれば knownTerminated へは移らない', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(4343);

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    expect(host.delegationSessionPids().live).toEqual(new Set([4343]));

    fake.emitError();

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });

  it('起こしたときに pid が取れなければ（起動そのものの失敗）、どちらの集合にも入らない', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(undefined);

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });

    expect(liveAndTerminatedOf(host)).toEqual({ live: new Set(), knownTerminated: new Set() });

    await host.shutdown();
  });

  it('同じセッションの中で複数回起きても、live は pid ごとに独立して数える（exit しても委譲自身が生きていれば knownTerminated へは回らない）', async () => {
    const sessions: CapturedSession[] = [];
    const workerA = fakeDelegationProcess(101);
    const workerB = fakeDelegationProcess(102);
    let call = 0;
    const spawnFn = () => {
      call += 1;
      return call === 1 ? workerA.handle : workerB.handle;
    };

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: spawnFn,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    const spawnOptions = {
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    };
    options.spawnClaudeCodeProcess?.(spawnOptions);
    options.spawnClaudeCodeProcess?.(spawnOptions);

    expect(host.delegationSessionPids().live).toEqual(new Set([101, 102]));

    workerA.emitExit();
    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([102]),
      knownTerminated: new Set(),
    });

    workerB.emitExit();
    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });

  it('childUser を渡さなければ spawnClaudeCodeProcess 自体が渡らない（能力の削減ではなく、対象がそもそも無い）', async () => {
    const sessions: CapturedSession[] = [];
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    expect(options.spawnClaudeCodeProcess).toBeUndefined();
    expect(liveAndTerminatedOf(host)).toEqual({ live: new Set(), knownTerminated: new Set() });

    await host.shutdown();
  });

  it('delegationSessionPids() は写しを返す（呼び出し側が書き換えても内部状態は変わらない）', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(55);
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });

    const snapshot = host.delegationSessionPids();
    (snapshot.live as Set<number>).add(9999);
    expect(host.delegationSessionPids().live).toEqual(new Set([55]));
    await host.shutdown();
  });
});

describe('孤児回収が「委譲の終端」で判定すること（#1334 段1。レビュー指摘の是正）', () => {
  it('done（ターンを終えて次を待つ）委譲: プロセスが exit しても、host.stop() を呼ぶまでは knownTerminated へ回らない（孤児を撃たない）', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(555);
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });

    fake.emitExit();

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });

  it('stop された委譲: host.stop() を呼んだ後は、そのプロセスの pid が knownTerminated へ回る（孤児を撃ってよい）', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(555);
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options } = sessions[0] as CapturedSession;
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    fake.emitExit();

    await host.stop('mgr-1');

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
    });
  });

  it('resume で同じ委譲に新しいプロセスが立つと、古い pid は knownTerminated から外れる（古い孤児を撃たない）', async () => {
    const sessions: CapturedSession[] = [];
    const oldProcess = fakeDelegationProcess(555);
    const newProcess = fakeDelegationProcess(777);
    let call = 0;
    const spawnFn = () => {
      call += 1;
      return call === 1 ? oldProcess.handle : newProcess.handle;
    };

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: spawnFn,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    const { options: firstOptions } = sessions[0] as CapturedSession;
    firstOptions.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    oldProcess.emitExit();
    await host.stop('mgr-1');

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
    });

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      cwd: '/work/project',
      request: 'つづき',
    });
    expect(sessions).toHaveLength(2);
    const { options: secondOptions } = sessions[1] as CapturedSession;
    secondOptions.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([777]),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });
});

describe('自己失効（lost）した委譲の pid（#2352: 後任が同じ runner で走っていても、残骸を撃てる側へ回す）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function selfFencedHost(pid: number) {
    vi.useFakeTimers();
    const sessions: CapturedSession[] = [];
    const lostProcess = fakeDelegationProcess(pid);
    const successorProcess = fakeDelegationProcess(pid + 1);
    let call = 0;
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      enforceLease: true,
      // 実 I/O をさせない: fake timer では実 I/O が進まず、`#finish()` が assertion より遅れて解決する（runner-fence.test.ts と同じ）
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
      spawnAgentProcessFn: () => {
        call += 1;
        return call === 1 ? lostProcess.handle : successorProcess.handle;
      },
    });
    const spawnOptions = {
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    };

    await host.start({
      managerId: 'mgr-lost',
      request: 'やって',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });
    (sessions[0] as CapturedSession).options.spawnClaudeCodeProcess?.(spawnOptions);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.list().map((m) => m.managerId)).not.toContain('mgr-lost');

    await host.start({ managerId: 'mgr-successor', request: 'つづき', cwd: '/work/project' });
    (sessions[1] as CapturedSession).options.spawnClaudeCodeProcess?.(spawnOptions);

    return { host, lostProcess };
  }

  it('CLI が exit したら、その pid は knownTerminated へ回る（後任の委譲が走っていても）', async () => {
    const { host, lostProcess } = await selfFencedHost(4600);

    lostProcess.emitExit();

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([4601]),
      knownTerminated: new Set([4600]),
    });

    await host.shutdown();
  });

  it('（対照）CLI が exit するまでは live に残り、knownTerminated へは回らない（回収は CLI の終了に依る）', async () => {
    const { host } = await selfFencedHost(4700);

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([4700, 4701]),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });
});

// 閉じ方を外から選べる偽の SDK: `crash()` は読み取りを例外で落とし（failed）、`end()` はストリームを正常に閉じる（done）
function controllableSdk(sessions: CapturedSession[], controls: SessionControl[]): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.push({ options: params.options ?? {} });
    let close = (): void => undefined;
    let crash: (error: Error) => void = () => undefined;
    const closed = new Promise<void>((resolve, reject) => {
      close = resolve;
      crash = reject;
    });
    controls.push({ end: () => close(), crash: (error) => crash(error) });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
        }
      })();
      await closed;
    }

    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

type SessionControl = { end: () => void; crash: (error: Error) => void };

describe('failed / lost で閉じた CLI の pid は、同じ managerId を resume しても撃つ側に残る（#2352・#1334）', () => {
  const spawnOptions = {
    command: 'claude',
    args: [],
    env: {},
    signal: new AbortController().signal,
  };

  function crashHost(pids: number[]) {
    const sessions: CapturedSession[] = [];
    const controls: SessionControl[] = [];
    const processes = pids.map((pid) => fakeDelegationProcess(pid));
    let call = 0;
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: controllableSdk(sessions, controls),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      // 実 I/O をさせない: `#finish()` が実 git・cgroup を読みに行かないように（runner-fence.test.ts と同じ）
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
      spawnAgentProcessFn: () => {
        const process = processes[call];
        call += 1;
        return (process as (typeof processes)[number]).handle;
      },
    });
    const spawnIn = (index: number) =>
      (sessions[index] as CapturedSession).options.spawnClaudeCodeProcess?.(spawnOptions);
    const closedOf = async () => {
      await vi.waitFor(() => {
        expect(host.list().map((m) => m.managerId)).not.toContain('mgr-1');
      });
    };
    const reopen = async () => {
      await host.resume({
        managerId: 'mgr-1',
        sessionId: 'sess-1',
        cwd: '/work/project',
        request: 'つづき',
      });
    };
    return { host, sessions, controls, processes, spawnIn, closedOf, reopen };
  }

  it('failed（SDK の読み取りが例外で落ちた）: 古い CLI が exit した後に resume しても、古い pid は knownTerminated、新しい pid は live', async () => {
    const t = crashHost([555, 777]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();

    await t.reopen();
    t.spawnIn(1);

    expect(liveAndTerminatedOf(t.host)).toEqual({
      live: new Set([777]),
      knownTerminated: new Set([555]),
    });

    await t.host.shutdown();
  });

  // #5168 で反転: 元は「failed で閉じた回は、持ち主が名簿に居ても abandonedOwnerListed に入らない（木を丸ごと撃つ。#5162）」。
  // 担当が自分で切り離して tini に引き取られたサーバー（postgres）まで撃っていたため、名簿に居る間は CLI の枝だけを撃つ形へ変えた
  it('⭐ failed で閉じて resume で名簿に戻った回は、abandonedOwnerListed に入る（CLI の枝だけを撃つ。#5168）', async () => {
    const t = crashHost([555, 777]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();
    await t.reopen();
    t.spawnIn(1);

    const pids = t.host.delegationSessionPids();
    expect(t.host.list().map((m) => m.managerId)).toContain('mgr-1');
    expect(pids.knownTerminated).toEqual(new Set([555]));
    expect(pids.abandonedOwnerListed).toEqual(new Set([555]));

    await t.host.shutdown();
  });

  // #5168 の続きで反転: 元は「failed で閉じて resume されていない回は、abandonedOwnerListed に入らない（木を丸ごと撃つ）」。
  // 枠で落ちた担当は通る鍵で起こし直されるが、それまでの窓（鍵が尽きていれば数時間）に走査が当たり、resume の前に postgres を撃っていたため、
  // 鍵の付け替えの畳み（#5115）と同じ期限で戻りを待つ形へ変えた
  it('⭐ failed で閉じて resume を待つ間（PEER_PARK_TTL_MS）は abandonedOwnerListed に入り（CLI の枝だけを撃つ）、期限を過ぎたら外れる（木を丸ごと撃つ）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-24T06:00:00Z'));
      const t = crashHost([555, 777]);
      await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
      t.spawnIn(0);

      (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
      await t.closedOf();
      (t.processes[0] as { emitExit: () => void }).emitExit();

      // 名簿には居ない（resume 前）が、戻り待ちとして CLI の枝だけを撃つ側に置く
      expect(t.host.list().map((m) => m.managerId)).not.toContain('mgr-1');
      expect(t.host.delegationSessionPids().knownTerminated).toEqual(new Set([555]));
      expect(t.host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([555]));

      // 余裕を持たせて測る: 閉じる処理の間にも偽の時計は少し進むので、期限ちょうどの1ミリ秒では測れない
      vi.setSystemTime(new Date(Date.now() + PEER_PARK_TTL_MS - 60_000));
      expect(t.host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([555]));

      vi.setSystemTime(new Date(Date.now() + 120_000));
      const pids = t.host.delegationSessionPids();
      expect(pids.knownTerminated).toEqual(new Set([555]));
      expect(pids.abandonedOwnerListed).toEqual(new Set());

      await t.host.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('failed で閉じて戻りを待つ間に keepPeers 無しの停止（人間・クローンが止めた）が来たら、abandonedOwnerListed から外れる（木を丸ごと撃つ）', async () => {
    const t = crashHost([555, 777]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();
    expect(t.host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([555]));

    await t.host.stop('mgr-1');

    const pids = t.host.delegationSessionPids();
    expect(pids.knownTerminated).toEqual(new Set([555]));
    expect(pids.abandonedOwnerListed).toEqual(new Set());

    await t.host.shutdown();
  });

  it('（対照）ストリームが正常に閉じた（done）担当は戻り待ちにしない: 今どおり knownTerminated で、abandonedOwnerListed にも ownerListed にも入らない', async () => {
    const t = crashHost([555]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).end();
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();

    const pids = t.host.delegationSessionPids();
    expect(pids.knownTerminated).toEqual(new Set([555]));
    expect(pids.abandonedOwnerListed).toEqual(new Set());
    expect(pids.ownerListed).toEqual(new Set());

    await t.host.shutdown();
  });

  it('failed で閉じて resume した後、持ち主が名簿から消えたら abandonedOwnerListed から外れる（木を丸ごと撃つ）', async () => {
    const t = crashHost([555, 777]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();
    await t.reopen();
    t.spawnIn(1);
    expect(t.host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([555]));

    await t.host.stop('mgr-1');

    const pids = t.host.delegationSessionPids();
    expect(pids.knownTerminated).toEqual(new Set([555]));
    expect(pids.abandonedOwnerListed).toEqual(new Set());

    await t.host.shutdown();
  });

  it('lost（自己失効）: resume しても古い pid は knownTerminated、新しい pid は live', async () => {
    vi.useFakeTimers();
    try {
      const sessions: CapturedSession[] = [];
      const oldProcess = fakeDelegationProcess(4800);
      const newProcess = fakeDelegationProcess(4801);
      let call = 0;
      const host: RunnerHost = createRunnerHost({
        runnerId: 'runner-test',
        workspacePath: '/work',
        emit: () => undefined,
        queryFn: fakeSdk(sessions),
        env: {},
        childUser: { uid: 1000, gid: 1000 },
        enforceLease: true,
        readCgroupEventCountersFn: async () => ({}),
        finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
        spawnAgentProcessFn: () => {
          call += 1;
          return call === 1 ? oldProcess.handle : newProcess.handle;
        },
      });
      await host.start({
        managerId: 'mgr-1',
        request: 'やって',
        cwd: '/work/project',
        lease: { fence: 1, ttlMs: 30_000 },
      });
      (sessions[0] as CapturedSession).options.spawnClaudeCodeProcess?.(spawnOptions);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.list().map((m) => m.managerId)).not.toContain('mgr-1');
      oldProcess.emitExit();

      await host.resume({
        managerId: 'mgr-1',
        sessionId: 'sess-1',
        cwd: '/work/project',
        request: 'つづき',
      });
      (sessions[1] as CapturedSession).options.spawnClaudeCodeProcess?.(spawnOptions);

      expect(liveAndTerminatedOf(host)).toEqual({
        live: new Set([4801]),
        knownTerminated: new Set([4800]),
      });
      // 名簿に戻っている間は CLI の枝だけを撃つ（#5168）。名簿から消えれば木を丸ごと撃つ
      expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([4800]));
      await host.stop('mgr-1');
      expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set());

      await host.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('（対照）done で閉じた: resume すると古い pid は knownTerminated から外れる（守られる）', async () => {
    const t = crashHost([555, 777]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).end();
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();

    // done で閉じて名簿から消えた時点では、所有者がいないので撃つ側にある
    expect(t.host.delegationSessionPids().knownTerminated).toEqual(new Set([555]));

    await t.reopen();
    t.spawnIn(1);

    expect(liveAndTerminatedOf(t.host)).toEqual({
      live: new Set([777]),
      knownTerminated: new Set(),
    });

    await t.host.shutdown();
  });

  it('failed で閉じても、古い CLI がまだ exit していない間は knownTerminated に入らない（live のまま）', async () => {
    const t = crashHost([555, 777]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
    await t.closedOf();
    await t.reopen();
    t.spawnIn(1);

    expect(liveAndTerminatedOf(t.host)).toEqual({
      live: new Set([555, 777]),
      knownTerminated: new Set(),
    });

    await t.host.shutdown();
  });

  it('pid の使い回し: failed で閉じた pid と同じ番号で新しい CLI が起きたら、それは live であって knownTerminated ではない', async () => {
    const t = crashHost([555, 555]);
    await t.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    t.spawnIn(0);

    (t.controls[0] as SessionControl).crash(new Error('SIGABRT（テストの偽物）'));
    await t.closedOf();
    (t.processes[0] as { emitExit: () => void }).emitExit();
    expect(t.host.delegationSessionPids().knownTerminated).toEqual(new Set([555]));

    await t.reopen();
    t.spawnIn(1);

    expect(liveAndTerminatedOf(t.host)).toEqual({
      live: new Set([555]),
      knownTerminated: new Set(),
    });

    // 新しい CLI が exit しても、委譲が生きていれば守る側のまま（古い持ち主の印が残っていると、ここで撃つ側へ回る）
    (t.processes[1] as { emitExit: () => void }).emitExit();
    expect(liveAndTerminatedOf(t.host)).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
    });

    await t.host.shutdown();
  });
});

// 最初のセッションだけ、起動直後に CLI の背景処理を `backgroundTasks` 本流す偽物（2本目以降は流さない）
function sdkWithBackground(sessions: CapturedSession[], backgroundTasks: number): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    const first = sessions.length === 0;
    sessions.push({ options: params.options ?? {} });
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      if (first && backgroundTasks > 0) {
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: Array.from({ length: backgroundTasks }, (_, i) => ({
            task_id: `bg-${String(i)}`,
            task_type: 'local_bash',
            description: '',
          })),
          session_id: 'sess-fake',
          uuid: 'uuid-bg',
        } as unknown as SDKMessage;
      }
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
        }
      })();
      await closed;
    }

    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('鍵の付け替えの畳み（keepPeers）で背景処理を畳んだ CLI の pid は、同じ担当を resume しても撃つ側に残る（#5044）', () => {
  async function foldAndResume(
    backgroundTasks: number,
    stopOptions: { keepPeers?: boolean },
  ): Promise<RunnerHost> {
    const sessions: CapturedSession[] = [];
    const oldProcess = fakeDelegationProcess(555);
    const newProcess = fakeDelegationProcess(777);
    let call = 0;
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: sdkWithBackground(sessions, backgroundTasks),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => {
        call += 1;
        return call === 1 ? oldProcess.handle : newProcess.handle;
      },
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    (sessions[0] as CapturedSession).options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(host.list()[0]?.liveBackgroundTasks).toBe(backgroundTasks);
    });
    await host.stop('mgr-1', stopOptions);
    oldProcess.emitExit();

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      cwd: '/work/project',
      request: 'つづき',
    });
    (sessions[1] as CapturedSession).options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    return host;
  }

  it('⭐ 背景処理 1 本を抱えたまま鍵の付け替えで畳まれた: resume しても古い pid は knownTerminated、新しい pid は live', async () => {
    const host = await foldAndResume(1, { keepPeers: true });

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([777]),
      knownTerminated: new Set([555]),
    });
    await host.shutdown();
  });

  it('⭐ abandonedOwnerListed（#5162）: 背景処理を畳んだ回は、resume で名簿に戻っても knownTerminated の部分集合として abandonedOwnerListed に入る', async () => {
    const host = await foldAndResume(1, { keepPeers: true });

    const pids = host.delegationSessionPids();
    expect(pids.knownTerminated).toEqual(new Set([555]));
    expect(pids.abandonedOwnerListed).toEqual(new Set([555]));
    await host.shutdown();
  });

  it('（対照）背景処理の無い鍵の付け替えの畳み: resume すると古い pid は knownTerminated から外れる（守られる）', async () => {
    const host = await foldAndResume(0, { keepPeers: true });

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([777]),
      knownTerminated: new Set(),
    });
    await host.shutdown();
  });

  it('（対照）人間・畳みの停止（keepPeers 無し）は背景処理があっても今どおり守る（#4433）', async () => {
    const host = await foldAndResume(1, {});

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set([777]),
      knownTerminated: new Set(),
    });
    await host.shutdown();
  });
});

describe('鍵の付け替えで畳んでから resume で戻るまでの間も、担当の木を終端扱いにしない（#5115）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // resume は呼ばない: 畳み（stop）と resume の間の窓そのものを観測するため
  async function foldWithoutResume(
    backgroundTasks: number,
  ): Promise<{ host: RunnerHost; stop: (options?: { keepPeers?: boolean }) => Promise<void> }> {
    const sessions: CapturedSession[] = [];
    const cli = fakeDelegationProcess(555);
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: sdkWithBackground(sessions, backgroundTasks),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => cli.handle,
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    (sessions[0] as CapturedSession).options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(host.list()[0]?.liveBackgroundTasks).toBe(backgroundTasks);
    });
    await host.stop('mgr-1', { keepPeers: true });
    cli.emitExit();
    return { host, stop: (options = {}) => host.stop('mgr-1', options) };
  }

  it('⭐ 背景処理の無い鍵の付け替えの畳み: resume の前でも、古い pid は knownTerminated に入らない（担当の postgres を撃たない）', async () => {
    const { host } = await foldWithoutResume(0);

    expect(host.list()).toEqual([]);
    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
    });
    await host.shutdown();
  });

  it('（対照）背景処理を抱えたまま畳んだ回（#5044）は、resume の前から今どおり knownTerminated', async () => {
    const { host } = await foldWithoutResume(1);

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
    });
    await host.shutdown();
  });

  it('⭐ abandonedOwnerListed（#5162）: 背景処理を畳んだ回の戻り待ちの間は abandonedOwnerListed に入り（引き取られた枝を守る）、期限切れ・停止で外れる（木を丸ごと撃つ）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T21:00:00Z'));
    const { host } = await foldWithoutResume(1);

    expect(host.delegationSessionPids().knownTerminated).toEqual(new Set([555]));
    expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([555]));

    vi.setSystemTime(new Date(Date.now() + PEER_PARK_TTL_MS));
    expect(host.delegationSessionPids().knownTerminated).toEqual(new Set([555]));
    expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set());
    await host.shutdown();
  });

  it('畳んだ後に keepPeers 無しの停止が来たら、背景処理を畳んだ回でも abandonedOwnerListed から外れる', async () => {
    const { host, stop } = await foldWithoutResume(1);
    expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([555]));

    await stop();

    expect(host.delegationSessionPids().knownTerminated).toEqual(new Set([555]));
    expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set());
    await host.shutdown();
  });

  it('畳んだまま PEER_PARK_TTL_MS 戻らなければ、古い pid は knownTerminated へ回る（戻らない担当の木を永久に守らない）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T21:00:00Z'));
    const { host } = await foldWithoutResume(0);

    vi.setSystemTime(new Date(Date.now() + PEER_PARK_TTL_MS - 1));
    expect(host.delegationSessionPids().knownTerminated).toEqual(new Set());

    vi.setSystemTime(new Date(Date.now() + 1));
    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
    });
    await host.shutdown();
  });

  it('畳んだ後に keepPeers 無しの停止（人間・クローンが止めた）が来たら、古い pid は knownTerminated へ回る', async () => {
    const { host, stop } = await foldWithoutResume(0);

    await stop();

    expect(liveAndTerminatedOf(host)).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
    });
    await host.shutdown();
  });

  it('ownerListed（#5157）: 畳んで戻りを待つ間は名簿に居るので守る側（ownerListed）、期限切れ・停止で knownTerminated へ移り ownerListed から消える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T21:00:00Z'));
    const { host } = await foldWithoutResume(0);

    // abandonedOwnerListed（#5162）は新しい欄: 背景処理を畳んだ回ではないので、この3集合の期待値は変えず空で足すだけ
    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
      ownerListed: new Set([555]),
      abandonedOwnerListed: new Set(),
    });

    vi.setSystemTime(new Date(Date.now() + PEER_PARK_TTL_MS));
    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
      ownerListed: new Set(),
      abandonedOwnerListed: new Set(),
    });
    await host.shutdown();
  });
});

describe('委譲の観測の内訳の材料（#5157。撃つ判定の集合は変えない）', () => {
  const spawnOnce = (sessions: CapturedSession[]): void => {
    (sessions[0] as CapturedSession).options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
  };

  it('ownerListed: done の担当の exit 済みの CLI は ownerListed に入り、stop すると knownTerminated へ移る', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(555);
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fake.handle,
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    spawnOnce(sessions);

    expect(host.delegationSessionPids().ownerListed).toEqual(new Set());
    fake.emitExit();
    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set(),
      ownerListed: new Set([555]),
      abandonedOwnerListed: new Set(),
    });

    await host.stop('mgr-1');
    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
      ownerListed: new Set(),
      abandonedOwnerListed: new Set(),
    });
  });

  it('所有者の記録: 4096 件までは忘れず、4097 件目の登録で忘れた累計が 1 になる', async () => {
    const sessions: CapturedSession[] = [];
    let next = 10_000;
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fakeDelegationProcess((next += 1)).handle,
    });
    expect(host.delegationPidOwnerRecords()).toEqual({
      remembered: 0,
      cap: 4096,
      forgottenTotal: 0,
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    for (let i = 0; i < 4096; i += 1) spawnOnce(sessions);
    expect(host.delegationPidOwnerRecords()).toEqual({
      remembered: 4096,
      cap: 4096,
      forgottenTotal: 0,
    });

    spawnOnce(sessions);
    expect(host.delegationPidOwnerRecords()).toEqual({
      remembered: 4096,
      cap: 4096,
      forgottenTotal: 1,
    });
    await host.shutdown();
  });

  it('所有者の記録: 同じ pid の再登録（pid の使い回し）は忘れたに数えない', async () => {
    const sessions: CapturedSession[] = [];
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => fakeDelegationProcess(777).handle,
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    spawnOnce(sessions);
    spawnOnce(sessions);

    expect(host.delegationPidOwnerRecords()).toEqual({
      remembered: 1,
      cap: 4096,
      forgottenTotal: 0,
    });
    await host.shutdown();
  });
});

// done まで進められ、背景処理と確認待ちも作れる偽の SDK
interface ControllableSession {
  options: Options;
  finish(): Promise<void>;
  setBackgroundTasks(count: number): Promise<void>;
  ask(): void;
}

function doneCapableSdk(sessions: ControllableSession[]): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    const queue: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (message: SDKMessage): void => {
      queue.push(message);
      wake?.();
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    sessions.push({
      options: params.options ?? {},
      async finish() {
        push({
          type: 'result',
          subtype: 'success',
          result: '済んだ',
          session_id: 'sess-fake',
          uuid: `uuid-result-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await settle();
      },
      async setBackgroundTasks(count) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: Array.from({ length: count }, (_, i) => ({
            task_id: `bg-${String(i)}`,
            task_type: 'local_bash',
            description: '',
          })),
          session_id: 'sess-fake',
          uuid: `uuid-bg-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await settle();
      },
      ask() {
        // await しない: 誰も答えないので、待つと waiting_human のままになる
        void params.options?.canUseTool?.('Bash', { command: 'echo hi' }, {
          signal: new AbortController().signal,
          toolUseID: `tool-${String(Math.random())}`,
          requestId: `req-${String(Math.random())}`,
        } as never);
      },
    });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
    return Object.assign(generate(), {
      close: () => {
        closed = true;
        wake?.();
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('終わって久しい done の担当の CLI の木を、CLI の枝だけ撃つ側へ回す（#5157。doneTreeReapAfterMs）', () => {
  const AFTER_MS = 6 * 60 * 60_000;
  const TINI = '/usr/bin/tini';
  const T0 = new Date('2026-10-20T21:00:00Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  interface Rig {
    host: RunnerHost;
    session: ControllableSession;
    processes: ReturnType<typeof fakeDelegationProcess>[];
    spawn: () => void;
    // CLI を起こして終わらせる（終了時刻は今）
    runAndExitCli: () => void;
  }

  async function rig(
    options: { doneTreeReapAfterMs?: number | null; subreaper?: string | null } = {},
  ): Promise<Rig> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const sessions: ControllableSession[] = [];
    const processes: ReturnType<typeof fakeDelegationProcess>[] = [];
    let nextPid = 555;
    const afterMs =
      options.doneTreeReapAfterMs === undefined ? AFTER_MS : options.doneTreeReapAfterMs;
    const subreaper = options.subreaper === undefined ? TINI : options.subreaper;
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: doneCapableSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => {
        const process = fakeDelegationProcess(nextPid);
        nextPid += 1;
        processes.push(process);
        return process.handle;
      },
      ...(subreaper === null ? {} : { delegationSubreaper: subreaper }),
      ...(afterMs === null ? {} : { doneTreeReapAfterMs: afterMs }),
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    await vi.waitFor(() => {
      expect(sessions).toHaveLength(1);
    });
    const session = sessions[0] as ControllableSession;
    const spawn = (): void => {
      session.options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
    };
    return {
      host,
      session,
      processes,
      spawn,
      runAndExitCli: () => {
        spawn();
        (processes[processes.length - 1] as { emitExit: () => void }).emitExit();
      },
    };
  }

  const advance = (ms: number): void => {
    vi.setSystemTime(new Date(Date.now() + ms));
  };

  async function makeDone(r: Rig): Promise<void> {
    // `vi.waitFor` は偽の時計を進める（Date まで動く）ので、前後で今を戻す: 期限の境目を1ms 単位で測るため
    const before = Date.now();
    await r.session.finish();
    await vi.waitFor(() => {
      expect(r.host.list()[0]?.status).toBe('done');
    });
    vi.setSystemTime(before);
  }

  const reaped = { knownTerminated: new Set([555]), abandonedOwnerListed: new Set([555]) };

  function reapedSets(host: RunnerHost): {
    knownTerminated: ReadonlySet<number>;
    abandonedOwnerListed: ReadonlySet<number>;
    ownerListed: ReadonlySet<number>;
  } {
    const { knownTerminated, abandonedOwnerListed, ownerListed } = host.delegationSessionPids();
    return { knownTerminated, abandonedOwnerListed, ownerListed };
  }

  it('⭐ tini 有り・名簿に居る・done・待ち無し・背景処理無し・CLI 全終了・期限以上前なら、abandonedOwnerListed と knownTerminated に入る', async () => {
    const r = await rig();
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS);

    expect(reapedSets(r.host)).toEqual({ ...reaped, ownerListed: new Set() });
    await r.host.shutdown();
  });

  it('期限の1ms前は ownerListed のまま（守る）', async () => {
    const r = await rig();
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS - 1);

    expect(reapedSets(r.host)).toEqual({
      knownTerminated: new Set(),
      abandonedOwnerListed: new Set(),
      ownerListed: new Set([555]),
    });
    await r.host.shutdown();
  });

  it('status が done でない（ターン中）なら期限が過ぎても ownerListed のまま', async () => {
    const r = await rig();
    r.runAndExitCli();
    advance(AFTER_MS);

    expect(r.host.list()[0]?.status).not.toBe('done');
    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());
    await r.host.shutdown();
  });

  it('確認待ち（waiting）が在れば ownerListed のまま', async () => {
    const r = await rig();
    r.runAndExitCli();
    r.session.ask();
    await r.session.finish();
    await vi.waitFor(() => {
      expect(r.host.list()[0]?.waiting.length).toBe(1);
    });
    advance(AFTER_MS);

    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());
    await r.host.shutdown();
  });

  it('背景処理（liveBackgroundTasks）が残っていれば、done でも ownerListed のまま', async () => {
    const r = await rig();
    r.runAndExitCli();
    await r.session.setBackgroundTasks(1);
    await makeDone(r);
    expect(r.host.list()[0]?.liveBackgroundTasks).toBe(1);
    advance(AFTER_MS);

    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());
    await r.host.shutdown();
  });

  it('担当のどれかの CLI が生きていれば、古い CLI の pid も ownerListed のまま（live の CLI は live）', async () => {
    const r = await rig();
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS);
    r.spawn();

    const pids = r.host.delegationSessionPids();
    expect(pids.live).toEqual(new Set([556]));
    expect(pids.ownerListed).toEqual(new Set([555]));
    expect(pids.knownTerminated).toEqual(new Set());
    await r.host.shutdown();
  });

  it('tini を挟まない構成（delegationSubreaper 無し）は、期限が過ぎても決して回さない（絞りが無く木を丸ごと撃つため）', async () => {
    const r = await rig({ subreaper: null });
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS * 100);

    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());
    expect(reapedSets(r.host).abandonedOwnerListed).toEqual(new Set());
    await r.host.shutdown();
  });

  it('期限を渡さない（無効。off と同じ）なら回さない', async () => {
    const r = await rig({ doneTreeReapAfterMs: null });
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS * 100);

    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());
    await r.host.shutdown();
  });

  it('持ち主が名簿に居ない（stop 済み）担当は、この経路ではなく今までどおり knownTerminated（ownerListed に残らない）', async () => {
    const r = await rig();
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS);
    await r.host.stop('mgr-1');

    expect(reapedSets(r.host)).toEqual({
      knownTerminated: new Set([555]),
      abandonedOwnerListed: new Set(),
      ownerListed: new Set(),
    });
    await r.host.shutdown();
  });

  it('⭐ 回された後に新しい CLI が起きる（resume 相当）と守る側へ戻り、その CLI が終わっても期限は終了時刻から数え直す', async () => {
    const r = await rig();
    r.runAndExitCli();
    await makeDone(r);
    advance(AFTER_MS);
    expect(reapedSets(r.host).abandonedOwnerListed).toEqual(new Set([555]));

    r.spawn();
    expect(r.host.delegationSessionPids().live).toEqual(new Set([556]));
    expect(reapedSets(r.host)).toEqual({
      knownTerminated: new Set(),
      abandonedOwnerListed: new Set(),
      ownerListed: new Set([555]),
    });

    (r.processes[1] as { emitExit: () => void }).emitExit();
    advance(AFTER_MS - 1);
    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555, 556]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());

    advance(1);
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set([555, 556]));
    expect(reapedSets(r.host).abandonedOwnerListed).toEqual(new Set([555, 556]));
    await r.host.shutdown();
  });

  it('担当の「最後の終了時刻」は pid ごとの終了時刻の最大: 新しい CLI が最近終わっていれば、古い pid も期限前は守る', async () => {
    const r = await rig();
    r.runAndExitCli();
    advance(AFTER_MS);
    r.runAndExitCli();
    await makeDone(r);

    expect(reapedSets(r.host).ownerListed).toEqual(new Set([555, 556]));
    expect(reapedSets(r.host).knownTerminated).toEqual(new Set());
    await r.host.shutdown();
  });

  it('pid の使い回し: 同じ pid の新しい CLI が起きると古い終了時刻は捨てられ、終わった時刻から数え直す', async () => {
    const sessions: ControllableSession[] = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const fake = [fakeDelegationProcess(777), fakeDelegationProcess(777)];
    let call = 0;
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: doneCapableSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => (fake[call++] as (typeof fake)[number]).handle,
      delegationSubreaper: TINI,
      doneTreeReapAfterMs: AFTER_MS,
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    await vi.waitFor(() => {
      expect(sessions).toHaveLength(1);
    });
    const session = sessions[0] as ControllableSession;
    const spawn = (): void => {
      session.options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
    };
    spawn();
    (fake[0] as (typeof fake)[number]).emitExit();
    await session.finish();
    await vi.waitFor(() => {
      expect(host.list()[0]?.status).toBe('done');
    });
    advance(AFTER_MS);
    expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set([777]));

    // 同じ pid の新しい CLI（古い終了時刻が残っていれば、終わった直後に期限切れとして回ってしまう）
    spawn();
    (fake[1] as (typeof fake)[number]).emitExit();
    expect(host.delegationSessionPids().abandonedOwnerListed).toEqual(new Set());
    expect(host.delegationSessionPids().ownerListed).toEqual(new Set([777]));
    await host.shutdown();
  });

  it('上限（4096）で所有者を忘れた pid は、終了時刻も含めてどの集合にも出ない。残りは期限後に回る', async () => {
    const sessions: ControllableSession[] = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    let next = 10_000;
    const exits: (() => void)[] = [];
    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: doneCapableSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => {
        next += 1;
        const process = fakeDelegationProcess(next);
        exits.push(process.emitExit);
        return process.handle;
      },
      delegationSubreaper: TINI,
      doneTreeReapAfterMs: AFTER_MS,
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    await vi.waitFor(() => {
      expect(sessions).toHaveLength(1);
    });
    const session = sessions[0] as ControllableSession;
    for (let i = 0; i < 4097; i += 1) {
      session.options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
    }
    for (const emitExit of exits) emitExit();
    await session.finish();
    await vi.waitFor(() => {
      expect(host.list()[0]?.status).toBe('done');
    });
    advance(AFTER_MS);

    const { abandonedOwnerListed, knownTerminated } = host.delegationSessionPids();
    expect(host.delegationPidOwnerRecords().forgottenTotal).toBe(1);
    expect(abandonedOwnerListed.has(10_001)).toBe(false);
    expect(knownTerminated.has(10_001)).toBe(false);
    expect(abandonedOwnerListed.size).toBe(4096);
    expect(knownTerminated.size).toBe(4096);
    await host.shutdown();
  });
});
