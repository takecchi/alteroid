import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerOutboxContent,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerStartCommand,
} from './runner-protocol.js';

/**
 * 試験の偽の `RunnerClient` の工場。口の既定は「何もしない・空・`undefined`」で、`start` / `resume` は頼まれた `cwd` をそのまま返す。
 * 試験が見る口だけ `overrides` で上書きする。
 * 既定を置くのは、いま必須の口だけ: 省略可能な口（`ping`・`identity`・`resources`・`unpushedWork` など）は既定を置かない。
 * ピックアップの口は、`openPickupFile` が何も開けず（`undefined`）、`deletePickupFile` が何もしない。
 * 置くと「口が無いとき」の道を通っていた試験の道が変わるため（持たない偽は、呼ぶ側がその口が無い場合の道へ倒す）。
 * クラスの偽は {@link FakeRunnerClientBase} を継ぐ（既定は同じ）。
 */
export function fakeRunnerClient(overrides: Partial<RunnerClient> = {}): RunnerClient {
  return {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    connect: () => Promise.resolve(),
    start: (command: RunnerStartCommand) => Promise.resolve({ cwd: command.cwd }),
    resume: (command: RunnerResumeCommand) => Promise.resolve({ cwd: command.cwd }),
    send: () => Promise.resolve(true),
    answer: () => Promise.resolve({ delivered: false }),
    stop: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    transcript: () => Promise.resolve(null),
    credentials: () => Promise.resolve([]),
    setCredentials: () => Promise.resolve([]),
    profile: () => Promise.resolve(undefined),
    setProfile: () => Promise.resolve({ ok: true }),
    openPickupFile: () => Promise.resolve(undefined),
    deletePickupFile: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

/**
 * 偽の `RunnerClient` をクラスで書くときの土台。既定は {@link fakeRunnerClient} と同じで、いま必須の口だけを持つ。
 * 省略可能な口は持たない（派生が必要な口だけ足す）。
 *
 * 型は実装クラスではなく `RunnerClient` の構築子として出す: 実装は引数を読まない（引数なしの関数）ので、
 * そのまま継ぐと派生が引数つきで上書きするときに型が合わない。`RunnerClient` の署名で見せれば、派生は契約どおりに書ける。
 */
export const FakeRunnerClientBase: abstract new () => RunnerClient = class implements RunnerClient {
  readonly runnerId: string = 'runner-primary';
  readonly runnerIdKnown: boolean = true;
  readonly workspacePath: string = '/work/project';
  readonly workspacePathKnown: boolean = true;

  async connect(): Promise<void> {}
  async start(command: RunnerStartCommand): Promise<{ cwd: string }> {
    return { cwd: command.cwd };
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd: string }> {
    return { cwd: command.cwd };
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async openPickupFile(): Promise<RunnerOutboxContent | undefined> {
    return undefined;
  }
  async deletePickupFile(): Promise<void> {}
  async close(): Promise<void> {}
};
