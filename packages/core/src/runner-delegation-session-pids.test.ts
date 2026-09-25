import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * 委譲の Claude Code プロセスの pid 追跡（#1334 段1）。
 *
 * **孤児の回収（`apps/runner/src/tasks.ts`）が「どのセッションが生きているか」を
 * 判定する唯一の材料は、ここで固定する配線が作る `host.delegationSessionPids()`
 * である。** 本物の `spawnAsUser` は別 UID への実プロセス生成（特権が要る）なので、
 * ここでは `RunnerHostOptions.spawnClaudeCodeProcessFn`（主にテスト用の差し替え口）
 * で実体を置き換え、**配線（pid を控える／終わったら忘れる）だけ**を実プロセス
 * 無しで固定する。
 */

type CapturedSession = { options: Options };

/**
 * `runner-registry.test.ts` の `fakeSdk` と同じ形（`options` を捕まえて、
 * `close()` されるまで開いたままにする）。ここで見たいのは `options` の中身
 * （`spawnClaudeCodeProcess` の有無と、それを呼んだときの配線）だけなので、
 * SDK 自身が `spawnClaudeCodeProcess` を呼ぶかどうかには依存しない——
 * テストが `options.spawnClaudeCodeProcess` を直接呼ぶ。
 */
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

/**
 * `SpawnedProcess`（SDK の型）を実プロセス無しで満たす最小の偽物。
 *
 * `pid` は `SpawnedProcess` の宣言には無いが、実物（`spawnAsUser` が返す Node の
 * `ChildProcess`）は持っている——`runner.ts` の `DelegationProcessHandle` が
 * その交差型で、ここもそれに合わせて `pid` を持たせる。
 *
 * **`on` / `once` / `off` は、SDK 側と同じ2本のオーバーロードとして公開する。**
 * `'exit'` 用と `'error'` 用を別々の配列で持つのは、1本の共有配列（緩い型）で
 * 持とうとすると、外から見える型（SDK の宣言そのまま）と実装の型が構造的に
 * 噛み合わなくなるため（TypeScript のオーバーロード判定の既知の制約）。
 */
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

  kill(_signal: NodeJS.Signals): boolean {
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
  it('起きたら live へ、exit したら knownTerminated へ移る', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(4242);

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnClaudeCodeProcessFn: () => fake.handle,
    });

    expect(host.delegationSessionPids()).toEqual({ live: new Set(), knownTerminated: new Set() });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    expect(sessions).toHaveLength(1);
    const { options } = sessions[0] as CapturedSession;
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');

    // **SDK がこのセッションの委譲プロセスを起こした、という体で呼ぶ。**
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

    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set([4242]),
    });

    await host.shutdown();
  });

  it('起こす前に失敗しても（error）、knownTerminated へ移る', async () => {
    const sessions: CapturedSession[] = [];
    const fake = fakeDelegationProcess(4343);

    const host: RunnerHost = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnClaudeCodeProcessFn: () => fake.handle,
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
      knownTerminated: new Set([4343]),
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
      spawnClaudeCodeProcessFn: () => fake.handle,
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

  /**
   * **1本の `RunnerSession` が複数回 `spawnClaudeCodeProcess` を呼ぶ形**
   * （マネージャー本体＋並列の作業者ごと）を、`live` が pid 単位で数えることを固定する。
   * `runner-2` の観測（issue #1334。3本並列の作業者）に対応する形である。
   */
  it('同じセッションの中で複数回起きても、pid ごとに独立して数える', async () => {
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
      spawnClaudeCodeProcessFn: spawnFn,
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
      knownTerminated: new Set([101]),
    });

    workerB.emitExit();
    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set([101, 102]),
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
      spawnClaudeCodeProcessFn: () => fake.handle,
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
    expect(host.delegationSessionPids().live).toEqual(new Set([55])); // 9999 は混ざらない

    await host.shutdown();
  });
});
