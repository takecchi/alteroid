import { randomUUID } from 'node:crypto';

import type { query } from '@anthropic-ai/claude-agent-sdk';

import type { CredentialStore } from './credentials.js';
import type { McpServers } from './mcp-servers.js';
import type { RunnerPlugin } from './plugins.js';
import type { ProfileVessel } from './profile.js';
import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerMcpServersFingerprint,
  RunnerOutboxContent,
  RunnerPlacementResources,
  RunnerPluginFingerprintEntry,
  RunnerPluginsFingerprint,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerRescueRefDeleteRequest,
  RunnerRescueRefDeleteResult,
  RunnerSetCredentialsCommand,
  RunnerAttachment,
  RunnerStartCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';
import { RUNNER_CAPABILITIES } from './runner-protocol.js';
import { readExecutionResources } from './runner-resources.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * 同一プロセスの manager-runner（ローカル実行用）。
 *
 * ローカルの既知の穴（マネージャーが同じ UID で走る）をツール削除で塞がない。
 * 塞ぐのはコンテナ構成の役目である（architecture.md）。
 */
export interface LocalRunnerOptions {
  runnerId?: string;
  workspacePath: string;
  queryFn?: typeof query;
  env?: NodeJS.ProcessEnv;
  withheldEnvKeys?: readonly string[];
  /** ローカルでも渡す: コンテナ構成でだけ鍵が回る、という差を作らないため。 */
  credentials?: CredentialStore;
  /** ローカルでも渡す: コンテナ構成でだけ `.zprofile` が効く形にしない（M4 受け入れ基準1）。 */
  profile?: ProfileVessel;
  attachmentsRoot?: string;
  pluginsRoot?: string;
  outboxRoot?: string;
  outboxStagedRoot?: string;
}

export function createLocalRunner(options: LocalRunnerOptions): RunnerClient {
  return new LocalRunner(options);
}

class LocalRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
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
      ...(options.attachmentsRoot === undefined
        ? {}
        : { attachmentsRoot: options.attachmentsRoot }),
      ...(options.pluginsRoot === undefined ? {} : { pluginsRoot: options.pluginsRoot }),
      ...(options.outboxRoot === undefined ? {} : { outboxRoot: options.outboxRoot }),
      ...(options.outboxStagedRoot === undefined
        ? {}
        : { outboxStagedRoot: options.outboxStagedRoot }),
    });
  }

  // 受け口が開く前の確認を捨てない: 捨てると、マネージャーが永久に返事を待つ。
  #deliver(event: RunnerEvent): void {
    if (this.#onEvent === null) {
      this.#queue.push(event);
      return;
    }
    this.#onEvent(event);
  }

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.#onEvent = onEvent;
    onEvent({
      type: 'hello',
      runnerId: this.runnerId,
      capabilities: [...RUNNER_CAPABILITIES],
    });
    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (event !== undefined) onEvent(event);
    }
  }

  // 省略しない: 省略すると「ローカルでは生死が分からない」という差が器の違いだけで生まれる。
  async ping(): Promise<void> {}

  // 省略しない: 配置の余地が無くても、「ローカルでは資源が見えない」という差を作らない。
  async resources(): Promise<RunnerPlacementResources> {
    return { managers: this.#host.list().length, ...(await readExecutionResources()) };
  }

  async start(command: RunnerStartCommand): Promise<{ cwd: string; sessionGeneration: string }> {
    return this.#host.start(command);
  }

  async resume(command: RunnerResumeCommand): Promise<{
    cwd: string;
    reusedLiveSession: boolean;
    sessionGeneration: string;
  }> {
    return this.#host.resume(command);
  }

  // 戻り値の `boolean` を捨てない: 捨てると、セッションが無い `managerId` でも「成功した」ように見える。
  async send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean> {
    return this.#host.send(managerId, text, attachments);
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

  async openOutboxFile(
    managerId: string,
    fileId: string,
  ): Promise<RunnerOutboxContent | undefined> {
    const file = await this.#host.openOutboxFile(managerId, fileId);
    return file === undefined ? undefined : { size: file.size, body: file.stream };
  }

  async deleteOutboxFile(managerId: string, fileId: string): Promise<void> {
    await this.#host.deleteOutboxFile(managerId, fileId);
  }

  async unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined> {
    return this.#host.unpushedWork(managerId, options);
  }

  async deleteRescueRef(
    request: RunnerRescueRefDeleteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerRescueRefDeleteResult> {
    return this.#host.deleteRescueRef(request, options);
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

  // 同じ口を通す: ローカルだけ記憶ストアを直に読ませると、HTTP の runner と「いつ・何が届くか」が別物になる（north_star 禁止1）。
  async mcpServers(): Promise<RunnerMcpServersFingerprint | undefined> {
    return this.#host.mcpServers();
  }

  async setMcpServers(servers: McpServers): Promise<RunnerMcpServersFingerprint | undefined> {
    return this.#host.setMcpServers(servers);
  }

  async plugins(): Promise<RunnerPluginsFingerprint | undefined> {
    return this.#host.plugins();
  }

  async setPlugin(plugin: RunnerPlugin): Promise<RunnerPluginFingerprintEntry> {
    return this.#host.setPlugin(plugin.name, plugin);
  }

  async retainPlugins(names: readonly string[]): Promise<RunnerPluginsFingerprint | undefined> {
    return this.#host.retainPlugins(names);
  }

  async setCodexAuth(push: { value: string; revision: string } | null): Promise<void> {
    await this.#host.setCodexAuth(push);
  }

  async takeCodexAuthWriteBack(
    fingerprint: string,
  ): Promise<{ value: string; baseRevision: string; fingerprint: string } | null> {
    return this.#host.takeCodexAuthWriteBack(fingerprint);
  }

  async close(): Promise<void> {
    this.#onEvent = null;
    await this.#host.shutdown();
  }
}
