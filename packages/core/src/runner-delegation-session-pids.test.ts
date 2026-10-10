import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';

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

    expect(host.delegationSessionPids()).toEqual({ live: new Set(), knownTerminated: new Set() });

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

    expect(host.delegationSessionPids()).toEqual({
      live: new Set([4242]),
      knownTerminated: new Set(),
    });

    fake.emitExit();

    // exit では knownTerminated へ入れない: 委譲が生きたままだと、nohup 等で残った子孫が孤児回収で撃たれる
    expect(host.delegationSessionPids()).toEqual({
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

    expect(host.delegationSessionPids()).toEqual({
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

    expect(host.delegationSessionPids()).toEqual({ live: new Set(), knownTerminated: new Set() });

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
    expect(host.delegationSessionPids()).toEqual({
      live: new Set([102]),
      knownTerminated: new Set(),
    });

    workerB.emitExit();
    expect(host.delegationSessionPids()).toEqual({
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
    expect(host.delegationSessionPids()).toEqual({ live: new Set(), knownTerminated: new Set() });

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

    expect(host.delegationSessionPids()).toEqual({
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

    expect(host.delegationSessionPids()).toEqual({
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

    expect(host.delegationSessionPids()).toEqual({
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

    expect(host.delegationSessionPids()).toEqual({
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

    expect(host.delegationSessionPids()).toEqual({
      live: new Set([4601]),
      knownTerminated: new Set([4600]),
    });

    await host.shutdown();
  });

  it('（対照）CLI が exit するまでは live に残り、knownTerminated へは回らない（回収は CLI の終了に依る）', async () => {
    const { host } = await selfFencedHost(4700);

    expect(host.delegationSessionPids()).toEqual({
      live: new Set([4700, 4701]),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });
});
