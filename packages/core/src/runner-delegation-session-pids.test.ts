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
  /**
   * **⚠️ 期待値を反転した（レビュー指摘・#1334 の是正、2026-09-25）。**
   * 旧い実装は「このプロセス自身が `exit` した」時点で即 `knownTerminated` に
   * 入れていた——このテストの旧い期待値（`knownTerminated: new Set([4242])`）は
   * まさにその仕様を固定していた。だが `exit` は「そのプロセスが終わった」
   * ことしか言わず、**それを起こした委譲（`managerId: 'mgr-1'`）自身は
   * `host.stop()` も経ておらずここでは生きたまま**である——マネージャーが
   * ターンを終えて次の指示を待つ（`done`）間や、並列の作業者が1回の呼び出しを
   * 終えただけの間は、まさにこの形（プロセスは終わったが委譲は続く）になる。
   * 誤って `knownTerminated` に入れると、その pid の子孫（`nohup` 等で
   * 起こしたまま残るプロセス）が孤児回収で撃たれてしまう。
   *
   * 委譲そのものの終端（`stop` される・resume で戻る）の固定は、この下の
   * 「孤児回収の判定材料（委譲の終端で判定する。#1334 レビュー指摘の是正）」
   * describe 内にある。
   */
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

    // **`mgr-1` は `host.stop()` を経ていない（まだ `#sessions` に居る）。**
    // だから 4242 は `live` から落ちても `knownTerminated` へは回らない。
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

    // **⚠️ 期待値を反転した（上のテストと同じ理由。レビュー指摘・#1334 の是正）。**
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
   *
   * **⚠️ `knownTerminated` 側の期待値を反転した（レビュー指摘・#1334 の是正）。**
   * `workerA` / `workerB` はどちらも同じ委譲（`managerId: 'mgr-1'`）が起こした
   * プロセスで、そのプロセスが exit してもここでは `mgr-1` 自身が
   * `host.stop()` を経ていない——**作業者を1本ずつ終える働き方は、委譲そのもの
   * が終わったことを意味しない**ので、`knownTerminated` はどちらの exit の
   * 後も空のままになる。
   */
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

/**
 * **孤児回収（#1334 段1）が「委譲の終端」で判定することを固定する（レビュー指摘の
 * 是正、2026-09-25）。** 直す前は `knownTerminated` を「そのプロセス自身が
 * `exit` したか」だけで判定していた——マネージャーがターンを終えて次の指示を
 * 待つ（`done`）間も、並列の作業者が1回の呼び出しを終えただけの間も、その
 * プロセスは `exit` するが**委譲そのものは終わっていない**。誤って撃つと、
 * その孤児の子孫（`nohup` で起こしたサーバ・長時間の背景処理）まで巻き込む。
 *
 * ここで固定する3本は、依頼（レビュー指摘）が名指ししたものと1対1で対応する:
 * - `done`（ターンの合間で待つ）委譲の孤児は撃たない
 * - `stop` された委譲の孤児は撃つ
 * - `resume` で同じ委譲に新しいプロセスが立っても、古い孤児は撃たない
 */
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

    // **1回のターンを終えて次の指示を待つ（`done`）。** `host.stop()` はまだ
    // 呼んでいない——`mgr-1` は runner にまだ生きたセッションとして残っている。
    fake.emitExit();

    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set(), // 555 の孤児は撃ってはいけない
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
    fake.emitExit();

    await host.stop('mgr-1');

    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]), // 委譲そのものが終端したので撃ってよい
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
      spawnClaudeCodeProcessFn: spawnFn,
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

    // **ここまでは直上の「stop された委譲」と同じ形**——古い pid（555）は
    // いったん撃ってよい側に居る。
    expect(host.delegationSessionPids()).toEqual({
      live: new Set(),
      knownTerminated: new Set([555]),
    });

    // **resume で同じ managerId に新しいプロセスが立つ。**
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

    // **古い pid（555）は、委譲(mgr-1)が resume で runner へ戻った時点で
    // knownTerminated から外れる**——委譲そのものが続いている以上、その古い
    // プロセスの孤児（555 の子孫）を撃ってよいとは、もう言えない。
    expect(host.delegationSessionPids()).toEqual({
      live: new Set([777]),
      knownTerminated: new Set(),
    });

    await host.shutdown();
  });
});
