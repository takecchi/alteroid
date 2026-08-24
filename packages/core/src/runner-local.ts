import { randomUUID } from 'node:crypto';

import type { query } from '@anthropic-ai/claude-agent-sdk';

import type { CredentialStore } from './credentials.js';
import type { ProfileVessel } from './profile.js';
import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerSetCredentialsCommand,
  RunnerStartCommand,
} from './runner-protocol.js';
import { readExecutionResources } from './runner-resources.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * 同一プロセスの manager-runner（ローカル実行用）。
 *
 * `alteroid chat` を叩くだけでクローンが使えることは M1 からの体験であり、
 * そこに「先に runner を立てる」手順を足さない。**器を分けられないローカルでは
 * 既知の穴（マネージャーが同じ UID で走る）が残る** — architecture.md に書いてある
 * とおりで、その穴をツール削除で塞がないこと。塞ぐのはコンテナ構成の役目である。
 *
 * デーモンから見た顔は HTTP 実装と同じ（`RunnerClient`）。デーモンが特定の
 * 実装やローカルパスを前提にしないための入れ子である。
 */
export interface LocalRunnerOptions {
  runnerId?: string;
  workspacePath: string;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  env?: NodeJS.ProcessEnv;
  withheldEnvKeys?: readonly string[];
  /**
   * 鍵の器。ローカルでも渡せるようにしてあるのは、**コンテナ構成でだけ鍵が回る**
   * という差を作らないためである（器が違うだけで、上の層が見るものは同じ）。
   */
  credentials?: CredentialStore;
  /**
   * プロファイルの器。**ローカルでも渡す。** コンテナ構成でだけ `.zprofile` が
   * 効く形にすると、器が違うだけでできることが変わってしまう（M4 受け入れ基準1）。
   */
  profile?: ProfileVessel;
}

export function createLocalRunner(options: LocalRunnerOptions): RunnerClient {
  return new LocalRunner(options);
}

class LocalRunner implements RunnerClient {
  readonly runnerId: string;
  /**
   * **常に `true`。** `HttpRunner` と違って `/health` を聞きに行って初めて
   * `runnerId` が定まる、という段階が無い——同一プロセスなので、コンストラクタの
   * 時点で自分の `runnerId` を確定させている（既定でも `local-<uuid>` を生成する。
   * 上のコンストラクタを参照）。「聞けていない」状態がそもそも存在しない（#330）。
   */
  readonly runnerIdKnown = true;
  readonly workspacePath: string;
  readonly #host: RunnerHost;
  readonly #queue: RunnerEvent[] = [];
  #onEvent: ((event: RunnerEvent) => void) | null = null;

  constructor(options: LocalRunnerOptions) {
    this.runnerId = options.runnerId ?? `local-${randomUUID().slice(0, 8)}`;
    this.workspacePath = options.workspacePath;
    this.#host = createRunnerHost({
      runnerId: this.runnerId,
      workspacePath: this.workspacePath,
      emit: (event) => this.#deliver(event),
      ...(options.queryFn === undefined ? {} : { queryFn: options.queryFn }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.withheldEnvKeys === undefined
        ? {}
        : { withheldEnvKeys: options.withheldEnvKeys }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
  }

  /**
   * 受け口が開く前の出来事も落とさない。
   *
   * 起動直後や再接続の隙に降りてきた確認を捨てると、マネージャーは永久に返事を
   * 待つ（誰も答えられない待ちが残る）。
   */
  #deliver(event: RunnerEvent): void {
    if (this.#onEvent === null) {
      this.#queue.push(event);
      return;
    }
    this.#onEvent(event);
  }

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.#onEvent = onEvent;
    onEvent({ type: 'hello', runnerId: this.runnerId });
    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (event !== undefined) onEvent(event);
    }
  }

  /**
   * 名乗り。**同一プロセスなので、ここが動いている時点で生きている。**
   *
   * 叩く先が無いからと省略しない — 省略すると「ローカルでは生死が分からない」
   * という差が器の違いだけで生まれる（コンテナ構成でだけ効く仕組みを作らない）。
   */
  async ping(): Promise<void> {}

  /**
   * 配置の材料。**同じ器の資源をそのまま読む。**
   *
   * ローカルは runner が1台しか無いので配置の余地は無いが、`ping` と同じ理由で
   * 省略しない — 省略すると「ローカルでは資源が見えない」という差が器の違いだけで
   * 生まれる（コンテナ構成でだけ効く仕組みを作らない）。
   */
  async resources(): Promise<RunnerPlacementResources> {
    return { managers: this.#host.list().length, ...(await readExecutionResources()) };
  }

  async start(command: RunnerStartCommand): Promise<void> {
    await this.#host.start(command);
  }

  async resume(command: RunnerResumeCommand): Promise<void> {
    await this.#host.resume(command);
  }

  async send(managerId: string, text: string): Promise<void> {
    await this.#host.send(managerId, text);
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    return this.#host.answer(managerId, answer);
  }

  async stop(managerId: string): Promise<void> {
    await this.#host.stop(managerId);
  }

  async list() {
    return this.#host.list();
  }

  async transcript(managerId: string): Promise<string | null> {
    return this.#host.transcript(managerId);
  }

  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return this.#host.credentials();
  }

  async setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]> {
    return this.#host.setCredentials(credentials);
  }

  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return this.#host.profile();
  }

  async setProfile(script: string): Promise<RunnerProfileResult> {
    return this.#host.setProfile(script);
  }

  /** 同じプロセスが消えるので、セッションごと畳む（HTTP 実装とはここが違う）。 */
  async close(): Promise<void> {
    this.#onEvent = null;
    await this.#host.shutdown();
  }
}
