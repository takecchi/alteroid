import { randomUUID } from 'node:crypto';

import type { query } from '@anthropic-ai/claude-agent-sdk';

import type {
  RunnerAnswerCommand,
  RunnerClient,
  RunnerEvent,
  RunnerResumeCommand,
  RunnerStartCommand,
} from './runner-protocol.js';
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
}

export function createLocalRunner(options: LocalRunnerOptions): RunnerClient {
  return new LocalRunner(options);
}

class LocalRunner implements RunnerClient {
  readonly runnerId: string;
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

  async start(command: RunnerStartCommand): Promise<void> {
    await this.#host.start(command);
  }

  async resume(command: RunnerResumeCommand): Promise<void> {
    await this.#host.resume(command);
  }

  async send(managerId: string, text: string): Promise<void> {
    await this.#host.send(managerId, text);
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean> {
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

  /** 同じプロセスが消えるので、セッションごと畳む（HTTP 実装とはここが違う）。 */
  async close(): Promise<void> {
    this.#onEvent = null;
    await this.#host.shutdown();
  }
}
