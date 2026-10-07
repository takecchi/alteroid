/**
 * クローンのセッションの駆動役の Codex 実装（#486 M7 段 S8）。
 *
 * `agent-clone-session.ts` の中立の口（{@link AgentCloneDriver}）の裏で、マネージャー側と
 * **同じ app-server セッション**（`codex-manager-driver.ts` の {@link openCodexSession}）を動かす。
 * 子の起こし方・認証（API キーのときだけ ephemeral、`CODEX_API_KEY` は子の env から外す）・
 * 通知の畳み（toolAudit・圧縮・枠）・伏せ字は、そちらの実体をそのまま使う。**ここに足したのは、
 * クローンの材料（{@link AgentCloneSessionSpec}）を、その実体が読む材料へ写すことだけ。**
 *
 * ## オーナーの決定（安全の線）
 *
 * 「承認の仕組みと蒸留の2点は欠けたままでよい。クローンは基本的に Claude が推奨」。つまり:
 *
 * - **`approvalPolicy = never`・`sandbox = danger-full-access` で走らせる**（Claude の `auto` に当たる
 *   ものが Codex に無い）。権限モード（`spec.permissionMode`）は読まず、常に `bypassPermissions` として
 *   渡す。Codex の承認要求はそもそも届かないが、届いても**常に拒否する**（{@link denyEveryApproval}。
 *   許可の代用を作らない）。**承認の能力は無いと申告する**（{@link CODEX_CLONE_PROVIDER}）。
 * - **蒸留は持たない**（`distill` を定義しない・`compactionHook` は false）。圧縮の前に割り込む口が
 *   無い。Codex の圧縮は事後の `compaction` イベントとして観測するだけで、`onPreCompact` は呼ばれない。
 *   欠けは `provider-gaps.ts` が日誌・日報・`self_status` へ出す。
 *
 * ## 道具
 *
 * クローンの道具は `stdio` の中継（`clone-tools-transport.ts`）でしか渡せない（Codex は別プロセスで、
 * 自分のプロセスの中の MCP サーバを持てない）。{@link CodexCloneDriver.requiredToolsTransport} で
 * `clone.ts` へそう伝える。`inproc` が来たら開かずに投げる（道具の無いクローンを黙って起こさない）。
 *
 * ## 渡さないもの（持たない能力は申告して出す）
 *
 * `spec.sessionLog`（生ログの預け先。rollout は Codex 側の `CODEX_HOME` にある）・`onPreToolUse`・
 * `onPreCompact`・`onSubagentStop`（Codex はどれも呼ばない）。`contextUsage()` は常に reject。
 */

import type { AgentEvent } from './agent-events.js';
import type {
  AgentCloneDriver,
  AgentCloneSession,
  AgentCloneSessionSpec,
} from './agent-clone-session.js';
import type { AgentManagerSessionSpec, AgentPermissionDecision } from './agent-session.js';
import {
  openCodexSession,
  type CodexManagerDriverOptions,
  type CodexSession,
} from './codex-manager-driver.js';
import type { McpServers } from './mcp-servers.js';
import { MCP_SERVER_NAME } from './tools.js';

/** クローンの道具の MCP 名（Claude 側と同じ。`claude-provider.ts` の `cloneMcpServers`）。 */
const CLONE_TOOLS_NAME = MCP_SERVER_NAME;

/** Codex から承認を求められたときの答え。常に拒否する（クローンは承認の能力を持たない）。 */
export function denyEveryApproval(): AgentPermissionDecision {
  return {
    behavior: 'deny',
    message:
      'クローンを Codex で動かすときは承認の能力を持たない（approvalPolicy=never で走らせている）。' +
      '承認が要る操作はここでは許可できない',
  };
}

/**
 * クローンの道具＋人間の MCP 連携を、Codex へ渡す MCP 登録（`McpServers`）へ。
 * **自作の道具が勝つ**（`cloneMcpServers` と同じ合成）。`inproc` は渡せないので投げる。
 */
export function toCodexCloneMcpServers(spec: {
  tools: AgentCloneSessionSpec['tools'];
  externalMcpServers: McpServers;
}): McpServers {
  if (spec.tools.kind !== 'stdio') {
    throw new Error(
      'Codex のクローンはクローンの道具を stdio の中継でしか受け取れない（inproc は渡せない）',
    );
  }
  const own: McpServers[string] = {
    type: 'stdio',
    command: spec.tools.command,
    args: spec.tools.args,
    env: spec.tools.env,
  };
  return { ...spec.externalMcpServers, [CLONE_TOOLS_NAME]: own };
}

/** クローンの材料を、app-server のセッションが読む材料へ写す。純粋関数。 */
export function toCodexSessionSpec(spec: AgentCloneSessionSpec): AgentManagerSessionSpec {
  return {
    ...(spec.resume === null ? {} : { resume: spec.resume }),
    input: spec.input,
    model: spec.model,
    // 人間が `ALTEROID_CLONE_MODEL` を置いたときだけ Codex へモデルを渡す（Claude の帯の名前を
    // Codex へ渡さない。マネージャーの `modelPlaced` と同じ）。
    modelPlaced: spec.modelPlaced === true,
    // **権限モードは読まない。** `bypassPermissions` ＝ approvalPolicy=never（`codexApprovalPolicyFor`）。
    permissionMode: 'bypassPermissions',
    systemPromptAppend: spec.systemPrompt,
    // 作業者は無い（`subagents` は false）。駆動役は読まない。
    workerAgentName: '',
    workerPrompt: '',
    workerModel: '',
    cwd: spec.cwd ?? process.cwd(),
    env: spec.env,
    managerAutoMemoryEnabled: false,
    mcpServers: toCodexCloneMcpServers(spec),
    // 預け先は使わない（`sessionLog` は false）。
    sessionLog: { append: async () => undefined, load: async () => null },
    onPermission: async () => denyEveryApproval(),
    ...(spec.onNote === undefined ? {} : { onNote: spec.onNote }),
    onPreToolUse: spec.onPreToolUse,
    // Codex は呼ばない（承認の拒否は `decline` で答え、分類器の拒否の合図は来ない）。
    onPermissionDenied: async () => ({ kind: 'no-retry' }),
    onPostToolUse: async (record) => {
      await spec.onPostToolUse(record);
      return { kind: 'continue' };
    },
    onPostToolUseFailure: spec.onPostToolUseFailure,
    onPreCompact: spec.onPreCompact,
    onUserPromptSubmit: () => undefined,
    onSubagentStop: async (record) => {
      await spec.onSubagentStop(record);
      return { kind: 'continue' };
    },
    onStop: () => undefined,
  };
}

class CodexCloneSession implements AgentCloneSession {
  readonly #session: CodexSession;

  constructor(session: CodexSession) {
    this.#session = session;
  }

  readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void> {
    return this.#session.readEvents(onEvent);
  }

  interrupt(): Promise<unknown> {
    return this.#session.interrupt();
  }

  close(): void {
    this.#session.close();
  }

  contextUsage(): ReturnType<CodexSession['contextUsage']> {
    return this.#session.contextUsage();
  }

  sessionModelUsage(): ReturnType<CodexSession['sessionModelUsage']> {
    return this.#session.sessionModelUsage();
  }
}

export class CodexCloneDriver implements AgentCloneDriver {
  readonly providerId = 'codex';
  /** クローンの道具は stdio の中継越しにしか渡せない（上の doc）。`clone.ts` が経路を決めるのに読む。 */
  readonly requiredToolsTransport = 'stdio';
  /** Codex は文脈の使用状況を出さない（`contextUsage()` は常に reject）。 */
  readonly providesContextUsage = false;
  readonly #options: CodexManagerDriverOptions;

  constructor(options: CodexManagerDriverOptions = {}) {
    this.#options = options;
  }

  open(spec: AgentCloneSessionSpec): AgentCloneSession {
    // 渡す口が未確認なので渡さない。黙って落とすと「入れたのに効かない」が原因の出ない形になる。
    if (spec.plugins !== undefined && spec.plugins.length > 0) {
      spec.onNote?.(`plugin は Codex へ渡していない（${spec.plugins.length} 件）`);
    }
    return new CodexCloneSession(openCodexSession(toCodexSessionSpec(spec), this.#options));
  }

  // `distill` は定義しない（蒸留のサイドクエリを持たない）。
}
