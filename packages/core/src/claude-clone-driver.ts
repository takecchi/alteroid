import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Query, SessionStore } from '@anthropic-ai/claude-agent-sdk';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentCloneDistillSpec,
  AgentCloneDriver,
  AgentCloneSession,
  AgentCloneSessionSpec,
  AgentCloneTools,
} from './agent-clone-session.js';
import {
  buildCloneDistillOptions,
  buildCloneSessionOptions,
  cloneMcpServers,
  foldClaudeMessage,
} from './claude-provider.js';
import { toSdkInput } from './claude-user-content.js';
import { stageCloneMcpServers, type CloneMcpConfigFile } from './clone-mcp-config-file.js';
import { readSessionUsage } from './usage.js';

type ClaudeCloneQueryFn = typeof query;

export function toClaudeMcpServerConfig(tools: AgentCloneTools): McpServerConfig {
  return tools.server as McpServerConfig;
}

// 資格つきの MCP 登録は CLI の argv ではなくファイルで渡す: argv は同じ器の他のプロセスから読めるため
function stageMcpConfig(
  tools: AgentCloneTools,
  externalMcpServers: Readonly<Record<string, McpServerConfig>> | undefined,
): { mcpServer: McpServerConfig; file: CloneMcpConfigFile | undefined } {
  const mcpServer = toClaudeMcpServerConfig(tools);
  const { file } = stageCloneMcpServers(cloneMcpServers(mcpServer, externalMcpServers));
  return { mcpServer, file };
}

export class ClaudeCloneDriver implements AgentCloneDriver {
  readonly providerId = 'claude';
  readonly #queryFn: ClaudeCloneQueryFn;

  constructor(options: { queryFn?: ClaudeCloneQueryFn } = {}) {
    this.#queryFn = options.queryFn ?? query;
  }

  open(spec: AgentCloneSessionSpec): AgentCloneSession {
    const { mcpServer, file } = stageMcpConfig(spec.tools, spec.externalMcpServers);
    const removeMcpConfig = (): void => file?.remove();
    const startupExternalNames = file === undefined ? [] : Object.keys(spec.externalMcpServers);
    let q: Query;
    try {
      q = this.#queryFn({
        prompt: toSdkInput(spec.input),
        options: buildCloneSessionOptions({
          model: spec.model,
          permissionMode: spec.permissionMode,
          mcpServer,
          externalMcpServers: spec.externalMcpServers,
          ...(file === undefined ? {} : { mcpConfigPath: file.path }),
          ...(spec.plugins === undefined ? {} : { plugins: spec.plugins }),
          systemPrompt: spec.systemPrompt,
          env: spec.env,
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          resume: spec.resume,
          // 写し直さない: 包み直すと SDK が見る形が変わるため
          ...(spec.sessionLog === undefined
            ? {}
            : { sessionStore: spec.sessionLog as unknown as SessionStore }),
          onPreToolUse: spec.onPreToolUse,
          onPreCompact: spec.onPreCompact,
          onPostToolUse: spec.onPostToolUse,
          onPostToolUseFailure: spec.onPostToolUseFailure,
          onSubagentStop: spec.onSubagentStop,
        }),
      });
    } catch (error) {
      removeMcpConfig();
      throw error;
    }
    return {
      readEvents: async (onEvent) => {
        try {
          for await (const message of q) {
            for (const event of foldClaudeMessage(message)) await onEvent(event);
          }
        } finally {
          removeMcpConfig();
        }
      },
      // `mcpServer`（自作のインプロセス MCP）を毎回合成して渡す: `setMcpServers` は渡した名前以外の動的な登録を外すので、省くと自分の道具が消える
      // 資格は control channel（標準入力）で渡り、argv にもファイルにも書かない
      // 起動時のファイル（`--mcp-config`）の登録は、袋から外しても CLI が外さない（実機で確認。0.3.318）: 外れた名前は `retained` で申告し、黙って「反映した」にしない
      setExternalMcpServers: async (servers) => {
        const result = await q.setMcpServers(cloneMcpServers(mcpServer, servers));
        return {
          added: result.added,
          removed: result.removed,
          failed: Object.keys(result.errors),
          retained: startupExternalNames.filter((name) => !(name in servers)),
        };
      },
      interrupt: () => q.interrupt(),
      close: () => {
        // 先に消す: close が投げても資格のファイルを残さないため
        removeMcpConfig();
        q.close();
      },
      contextUsage: () => q.getContextUsage(),
      sessionModelUsage: () => readSessionUsage(q),
    };
  }

  distill(spec: AgentCloneDistillSpec): AsyncIterable<AgentEvent> {
    const { mcpServer, file } = stageMcpConfig(spec.tools, spec.externalMcpServers);
    let side: Query;
    try {
      side = this.#queryFn({
        prompt: spec.prompt,
        options: buildCloneDistillOptions({
          model: spec.model,
          permissionMode: spec.permissionMode,
          mcpServer,
          externalMcpServers: spec.externalMcpServers,
          ...(file === undefined ? {} : { mcpConfigPath: file.path }),
          ...(spec.plugins === undefined ? {} : { plugins: spec.plugins }),
          systemPrompt: spec.systemPrompt,
          env: spec.env,
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          onPostToolUse: spec.onPostToolUse,
          onPostToolUseFailure: spec.onPostToolUseFailure,
        }),
      });
    } catch (error) {
      file?.remove();
      throw error;
    }
    return (async function* (): AsyncGenerator<AgentEvent> {
      try {
        for await (const message of side) yield* foldClaudeMessage(message);
      } finally {
        file?.remove();
      }
    })();
  }
}
