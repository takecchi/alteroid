import type { RunnerPlugin as RunnerPluginPush } from './plugins.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerMcpServersFingerprint,
  RunnerOutboxContent,
  RunnerPluginFingerprintEntry,
  RunnerPermissionRulesResult,
  RunnerPlacementResources,
  RunnerPluginsFingerprint,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRescueRefDeleteResult,
  RunnerResumeCommand,
  RunnerStartCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';

const STAGE_ATTACHMENT_UNSUPPORTED = 'この偽は大きいファイルを受け取らない';

function pluginFingerprintEntryOf(plugin: RunnerPluginPush): RunnerPluginFingerprintEntry {
  return {
    name: plugin.name,
    sha: plugin.sourceSha,
    contentSha256: plugin.contentSha256,
    enableHooks: plugin.enableHooks,
    enableMcp: plugin.enableMcp,
  };
}

/**
 * 試験の偽の `RunnerClient` の工場。口の既定は「何もしない・空・`undefined`」で、`start` / `resume` は頼まれた `cwd` をそのまま返す。
 * 試験が見る口だけ `overrides` で上書きする。
 * 既定を置くのは、いま必須の口だけ: 省略可能な口（`ping`・`identity`・`stagesSince` など）は既定を置かない。
 * ピックアップの口は、`openPickupFile` が何も開けず（`undefined`）、`deletePickupFile` が何もしない。
 * アーカイブの口は、`fetchArchive` が何も預かっておらず（`undefined`）、`deleteArchive` が何もしない。
 * MCP の口は、`mcpServers` が何も置いていない（`undefined`）、`setMcpServers` が何も置かず指紋も返さない（`undefined`）。
 * plugin の口は、`plugins` が何も持っていない（`undefined`）、`setPlugin` が受け取った plugin の指紋をそのまま返し、`retainPlugins` が何も外さず指紋も返さない（`undefined`）。
 * Codex の認証の口は、`setCodexAuth` が何もせず、`takeCodexAuthWriteBack` が書き戻し無し（`null`）。
 * 読む・探る口は、`resources` が資源を報告せず（`undefined`）、`transcriptTail` が末尾無し（`null`）、`unpushedWork` が確かめられない（`undefined`）。
 * 置く・消す口は、`stageAttachment` が受け取れず投げ（呼び手は理由つきで断る）、`deleteRescueRef` が消せなかった（`failed`・`other`）、`setPermissionRules` が何も置かない（`count: 0`・`changed: false`）。
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
    fetchArchive: () => Promise.resolve(undefined),
    deleteArchive: () => Promise.resolve(),
    mcpServers: () => Promise.resolve(undefined),
    setMcpServers: () => Promise.resolve(undefined),
    plugins: () => Promise.resolve(undefined),
    setPlugin: (plugin: RunnerPluginPush) => Promise.resolve(pluginFingerprintEntryOf(plugin)),
    retainPlugins: () => Promise.resolve(undefined),
    setCodexAuth: () => Promise.resolve(),
    takeCodexAuthWriteBack: () => Promise.resolve(null),
    resources: () => Promise.resolve(undefined),
    transcriptTail: () => Promise.resolve(null),
    unpushedWork: () => Promise.resolve(undefined),
    stageAttachment: () => Promise.reject(new Error(STAGE_ATTACHMENT_UNSUPPORTED)),
    deleteRescueRef: () => Promise.resolve({ outcome: 'failed', kind: 'other' }),
    setPermissionRules: () => Promise.resolve({ count: 0, changed: false }),
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
  async fetchArchive(): Promise<string | undefined> {
    return undefined;
  }
  async deleteArchive(): Promise<void> {}
  async mcpServers(): Promise<RunnerMcpServersFingerprint | undefined> {
    return undefined;
  }
  async setMcpServers(): Promise<RunnerMcpServersFingerprint | undefined> {
    return undefined;
  }
  async plugins(): Promise<RunnerPluginsFingerprint | undefined> {
    return undefined;
  }
  async setPlugin(plugin: RunnerPluginPush): Promise<RunnerPluginFingerprintEntry> {
    return pluginFingerprintEntryOf(plugin);
  }
  async retainPlugins(): Promise<RunnerPluginsFingerprint | undefined> {
    return undefined;
  }
  async setCodexAuth(): Promise<void> {}
  async takeCodexAuthWriteBack(): Promise<null> {
    return null;
  }
  async resources(): Promise<RunnerPlacementResources | undefined> {
    return undefined;
  }
  async transcriptTail(): Promise<string | null> {
    return null;
  }
  async unpushedWork(): Promise<UnpushedWorkResult | undefined> {
    return undefined;
  }
  async stageAttachment(): Promise<void> {
    throw new Error(STAGE_ATTACHMENT_UNSUPPORTED);
  }
  async deleteRescueRef(): Promise<RunnerRescueRefDeleteResult> {
    return { outcome: 'failed', kind: 'other' };
  }
  async setPermissionRules(): Promise<RunnerPermissionRulesResult> {
    return { count: 0, changed: false };
  }
  async close(): Promise<void> {}
};
