// この口を `clone.ts` へ戻さない: 別の provider で動かすとき `query()` 呼びを1つずつ掘り出すことになるため

import type { AgentEvent } from './agent-events.js';
import type {
  AgentObservationHook,
  AgentPreCompactRecord,
  AgentPreToolHook,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
} from './agent-hooks.js';
import type { AgentProviderId } from './agent-ports.js';
import type { AgentContextUsage, AgentSessionLog, AgentUserInput } from './agent-session.js';
import type { McpServers } from './mcp-servers.js';
import type { PermissionModeName } from './permission-mode.js';
import type { UsageTotals } from './usage.js';

export type AgentCloneTools =
  | { readonly kind: 'inproc'; readonly server: unknown }
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args: string[];
      readonly env: Record<string, string>;
    };

export interface AgentCloneSessionSpec {
  resume: string | null;
  input: AsyncIterable<AgentUserInput>;
  model: string;
  modelPlaced?: boolean;
  permissionMode: PermissionModeName;
  tools: AgentCloneTools;
  externalMcpServers: McpServers;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onNote?: (text: string) => void;
  sessionLog?: AgentSessionLog;
  onPreToolUse: AgentPreToolHook;
  onPreCompact: AgentObservationHook<AgentPreCompactRecord>;
  onPostToolUse: AgentObservationHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
  onSubagentStop: AgentObservationHook<AgentSubagentStopRecord>;
}

export interface AgentCloneSession {
  readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void>;
  interrupt(): Promise<unknown>;
  close(): void;
  contextUsage(): Promise<AgentContextUsage>;
  sessionModelUsage(): Promise<Record<string, UsageTotals> | undefined>;
}

export interface AgentCloneDistillSpec {
  prompt: string;
  model: string;
  permissionMode: PermissionModeName;
  tools: AgentCloneTools;
  externalMcpServers: McpServers;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onPostToolUse: AgentObservationHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
}

export interface AgentCloneDriver {
  readonly providerId: AgentProviderId;
  readonly requiredToolsTransport?: 'stdio';
  readonly providesContextUsage?: false;
  open(spec: AgentCloneSessionSpec): AgentCloneSession;
  readonly distill?: (spec: AgentCloneDistillSpec) => AsyncIterable<AgentEvent>;
}
