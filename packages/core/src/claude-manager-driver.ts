/**
 * マネージャーのセッションの駆動役の Claude 実装（#486 段 S4）。
 *
 * `agent-session.ts` の中立の口（{@link AgentManagerDriver}）の裏で、SDK の
 * `query()`・`Options`（`buildManagerSessionOptions`）・メッセージの畳み込み
 * （`foldClaudeMessage`）・`canUseTool` の `PermissionResult` を扱う。
 * **SDK の型はこのファイルと `claude-provider.ts` の外へ出さない。**
 *
 * `queryFn` はこの駆動役のテスト用の差し替え口である（provider の境界ではない）。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  PermissionResult,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
  AgentPermissionDecision,
  AgentSessionLog,
  AgentUserInput,
} from './agent-session.js';
import { buildManagerSessionOptions, foldClaudeMessage } from './claude-provider.js';
import { toSdkContent } from './claude-user-content.js';
import { isDaemonAnsweredTool } from './daemon-answered-tool.js';
import { readSessionUsage } from './usage.js';

/** SDK の `query()` の型。テスト用の差し替え口の型であって、中立の口には出ない。 */
export type ClaudeQueryFn = typeof query;

/**
 * 中立の決定を SDK の `canUseTool` が返す `PermissionResult` へ写す。
 *
 * **欄を足さない・落とさない。** `allow` は `updatedInput` があるときだけそれを運び
 * （`AskUserQuestion` の答えがここを通る）、`deny` は `message` をそのまま運ぶ。
 */
export function toClaudePermissionResult(decision: AgentPermissionDecision): PermissionResult {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message };
  return decision.updatedInput === undefined
    ? { behavior: 'allow' }
    : { behavior: 'allow', updatedInput: decision.updatedInput };
}

async function* toSdkInput(input: AsyncIterable<AgentUserInput>): AsyncGenerator<SDKUserMessage> {
  for await (const next of input) {
    yield {
      type: 'user',
      message: { role: 'user', content: toSdkContent(next) },
      parent_tool_use_id: null,
    };
  }
}

function toSessionStore(log: AgentSessionLog): SessionStore {
  const keyOf = (key: SessionKey) => ({
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
  });
  return {
    append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
      await log.append(keyOf(key), entries);
    },
    load: async (key: SessionKey) => {
      const loaded = await log.load(keyOf(key));
      return (loaded ?? null) as SessionStoreEntry[] | null;
    },
  };
}

export class ClaudeManagerDriver implements AgentManagerDriver {
  readonly providerId = 'claude';
  readonly #queryFn: ClaudeQueryFn;

  constructor(options: { queryFn?: ClaudeQueryFn } = {}) {
    this.#queryFn = options.queryFn ?? query;
  }

  open(spec: AgentManagerSessionSpec): AgentManagerSession {
    const spawnProcess = spec.spawnProcess;
    const options = buildManagerSessionOptions({
      model: spec.model,
      permissionMode: spec.strictApprovals === true ? 'default' : spec.permissionMode,
      systemPromptAppend: spec.systemPromptAppend,
      workerAgentName: spec.workerAgentName,
      workerPrompt: spec.workerPrompt,
      workerModel: spec.workerModel,
      cwd: spec.cwd,
      env: spec.env,
      managerAutoMemoryEnabled: spec.managerAutoMemoryEnabled,
      ...(spec.mcpServers === undefined ? {} : { mcpServers: spec.mcpServers }),
      ...(spec.plugins === undefined ? {} : { plugins: spec.plugins }),
      sessionStore: toSessionStore(spec.sessionLog),
      ...(spec.resume === undefined ? {} : { resume: spec.resume }),
      ...(spawnProcess === undefined
        ? {}
        : {
            spawnClaudeCodeProcess: (spawnOptions) =>
              spawnProcess(spawnOptions) as unknown as SpawnedProcess,
          }),
      canUseTool: async (toolName, input, extra) =>
        toClaudePermissionResult(
          await spec.onPermission({
            requestId: extra.requestId ?? extra.toolUseID,
            kind: isDaemonAnsweredTool(toolName) ? 'question' : 'permission',
            toolName,
            input,
            ...(typeof extra.decisionReason === 'string' && extra.decisionReason.length > 0
              ? { reason: extra.decisionReason }
              : {}),
            signal: extra.signal,
          }),
        ),
      onPreToolUse: spec.onPreToolUse,
      onPermissionDenied: spec.onPermissionDenied,
      onPostToolUse: spec.onPostToolUse,
      onPostToolUseFailure: spec.onPostToolUseFailure,
      onPreCompact: spec.onPreCompact,
      onUserPromptSubmit: spec.onUserPromptSubmit,
      onSubagentStop: spec.onSubagentStop,
      onStop: spec.onStop,
    });
    const q = this.#queryFn({ prompt: toSdkInput(spec.input), options });
    return {
      readEvents: async (onEvent) => {
        // **provider の綴りを読むのはここまで**（`foldClaudeMessage`）。
        for await (const message of q) {
          for (const event of foldClaudeMessage(message)) await onEvent(event);
        }
      },
      close: () => q.close(),
      contextUsage: () => q.getContextUsage(),
      sessionModelUsage: () => readSessionUsage(q),
    };
  }
}
