/**
 * クローンのセッションの駆動役の Claude 実装（#486 M7 の前段）。
 *
 * `agent-clone-session.ts` の中立の口（{@link AgentCloneDriver}）の裏で、SDK の
 * `query()`・`Options`（`buildCloneSessionOptions` / `buildCloneDistillOptions`）・
 * メッセージの畳み込み（`foldClaudeMessage`）を扱う。**`clone.ts` が持っていた
 * 「`query()` を起こす・読む・止める」をそのまま移しただけで、挙動は変えていない**
 * （`clone-driver-options.test.ts` が `Options` を切り出し前後で固定している）。
 *
 * `queryFn` はこの駆動役のテスト用の差し替え口である（provider の境界ではない）。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, SDKUserMessage, SessionStore } from '@anthropic-ai/claude-agent-sdk';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentCloneDistillSpec,
  AgentCloneDriver,
  AgentCloneSession,
  AgentCloneSessionSpec,
  AgentCloneTools,
} from './agent-clone-session.js';
import type { AgentUserInput } from './agent-session.js';
import {
  buildCloneDistillOptions,
  buildCloneSessionOptions,
  foldClaudeMessage,
} from './claude-provider.js';
import { toSdkContent } from './claude-user-content.js';
import { readSessionUsage } from './usage.js';

/** SDK の `query()` の型。テスト用の差し替え口の型であって、中立の口には出ない。 */
export type ClaudeCloneQueryFn = typeof query;

/**
 * 中立の道具の渡し方を SDK の `McpServerConfig` へ戻す。
 *
 * **`inproc` は持ち手をそのまま返す**（`clone.ts` が組んだインスタンス入りの設定そのもの。
 * 作り直さない）。`stdio` は `clone-tools-transport.ts` が組む形（`type` / `command` /
 * `args` / `env` の順）をそのまま復元する。
 */
export function toClaudeMcpServerConfig(tools: AgentCloneTools): McpServerConfig {
  if (tools.kind === 'inproc') return tools.server as McpServerConfig;
  return { type: 'stdio', command: tools.command, args: tools.args, env: tools.env };
}

/** 中立のユーザー入力を SDK の入力メッセージへ写す（`clone.ts` が積んでいた形と同じ）。 */
async function* toSdkInput(input: AsyncIterable<AgentUserInput>): AsyncGenerator<SDKUserMessage> {
  for await (const next of input) {
    yield {
      type: 'user',
      message: { role: 'user', content: toSdkContent(next) },
      parent_tool_use_id: null,
    };
  }
}

export class ClaudeCloneDriver implements AgentCloneDriver {
  readonly providerId = 'claude';
  readonly #queryFn: ClaudeCloneQueryFn;

  constructor(options: { queryFn?: ClaudeCloneQueryFn } = {}) {
    this.#queryFn = options.queryFn ?? query;
  }

  open(spec: AgentCloneSessionSpec): AgentCloneSession {
    const options = buildCloneSessionOptions({
      model: spec.model,
      permissionMode: spec.permissionMode,
      mcpServer: toClaudeMcpServerConfig(spec.tools),
      externalMcpServers: spec.externalMcpServers,
      systemPrompt: spec.systemPrompt,
      env: spec.env,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      resume: spec.resume,
      // 預け先は `clone.ts` が渡した SDK の `SessionStore` そのもの（中立の口では
      // `AgentSessionLog` と名乗る）。写し直さない — 包み直すと SDK が見る形が変わる。
      ...(spec.sessionLog === undefined
        ? {}
        : { sessionStore: spec.sessionLog as unknown as SessionStore }),
      onPreToolUse: spec.onPreToolUse,
      onPreCompact: spec.onPreCompact,
      onPostToolUse: spec.onPostToolUse,
      onPostToolUseFailure: spec.onPostToolUseFailure,
      onSubagentStop: spec.onSubagentStop,
    });
    const q = this.#queryFn({ prompt: toSdkInput(spec.input), options });
    return {
      readEvents: async (onEvent) => {
        // **provider の綴りを読むのはここまで**（`foldClaudeMessage`）。
        for await (const message of q) {
          for (const event of foldClaudeMessage(message)) await onEvent(event);
        }
      },
      interrupt: () => q.interrupt(),
      close: () => q.close(),
      contextUsage: () => q.getContextUsage(),
      sessionModelUsage: () => readSessionUsage(q),
    };
  }

  distill(spec: AgentCloneDistillSpec): AsyncIterable<AgentEvent> {
    // **呼んだ時点で起こす**（`clone.ts` が `query()` をその場で呼んでいたのと同じ）。
    const side = this.#queryFn({
      prompt: spec.prompt,
      options: buildCloneDistillOptions({
        model: spec.model,
        permissionMode: spec.permissionMode,
        mcpServer: toClaudeMcpServerConfig(spec.tools),
        externalMcpServers: spec.externalMcpServers,
        systemPrompt: spec.systemPrompt,
        env: spec.env,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        onPostToolUse: spec.onPostToolUse,
        onPostToolUseFailure: spec.onPostToolUseFailure,
      }),
    });
    return (async function* (): AsyncGenerator<AgentEvent> {
      for await (const message of side) yield* foldClaudeMessage(message);
    })();
  }
}
