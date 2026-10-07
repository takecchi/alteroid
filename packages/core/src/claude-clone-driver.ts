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

export type ClaudeCloneQueryFn = typeof query;

export function toClaudeMcpServerConfig(tools: AgentCloneTools): McpServerConfig {
  if (tools.kind === 'inproc') return tools.server as McpServerConfig;
  return { type: 'stdio', command: tools.command, args: tools.args, env: tools.env };
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
      // 写し直さない: 包み直すと SDK が見る形が変わるため
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
