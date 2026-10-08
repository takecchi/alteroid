// `query()` の署名を共通 IF にしない: Claude 固有の制御モデルを全 provider に強いるため

import type { Readable, Writable } from 'node:stream';

import type { AgentClonePlugin } from './agent-clone-session.js';
import type { AgentEvent } from './agent-events.js';
import type {
  AgentContextHook,
  AgentObservationHook,
  AgentPermissionDeniedHook,
  AgentPreToolHook,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentPreCompactRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import type { AgentProviderId } from './agent-ports.js';
import type { McpServers } from './mcp-servers.js';
import type { PermissionModeName } from './permission-mode.js';
import type { UsageTotals } from './usage.js';

export interface AgentUserInput {
  readonly text: string;
  readonly images?: readonly AgentInputImage[];
}

export interface AgentInputImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
  readonly name?: string;
}

export interface AgentPermissionRequest {
  readonly requestId: string | undefined;
  readonly kind: 'question' | 'permission';
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reason?: string;
  readonly signal: AbortSignal;
}

export type AgentPermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string };

export type AgentPermissionHandler = (
  request: AgentPermissionRequest,
) => Promise<AgentPermissionDecision>;

export interface AgentSessionLogKey {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly subpath?: string;
}

export interface AgentSessionLog {
  append(key: AgentSessionLogKey, entries: unknown[]): Promise<void>;
  load(key: AgentSessionLogKey): Promise<unknown[] | null>;
}

export interface AgentSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface AgentChildProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly pid?: number;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export type AgentSpawnProcess = (options: AgentSpawnOptions) => AgentChildProcess;

export interface AgentContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  categories?: readonly {
    name: string;
    tokens: number;
    kind: 'used' | 'free' | 'buffer' | 'deferred';
  }[];
  mcpTools?: readonly { tokens: number }[];
  memoryFiles?: readonly { tokens: number }[];
  systemPromptSections?: readonly { tokens: number }[];
}

export interface AgentManagerSession {
  // AsyncIterable にしない: async generator の層が挟まるとマイクロタスクの段数が増え、既存テストの fake が前提にしている競合の窓が動くため
  readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void>;
  close(): void;
  contextUsage(): Promise<AgentContextUsage>;
  sessionModelUsage(): Promise<Record<string, UsageTotals> | undefined>;
}

export interface AgentManagerSessionSpec {
  resume?: string;
  input: AsyncIterable<AgentUserInput>;
  model: string;
  modelPlaced?: boolean;
  permissionMode: PermissionModeName;
  strictApprovals?: boolean;
  systemPromptAppend: string;
  workerAgentName: string;
  workerPrompt: string;
  workerModel: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  managerAutoMemoryEnabled: boolean;
  mcpServers?: McpServers;
  /**
   * 展開済みの plugin（runner が置き場へ展開したもの）。省略・空なら渡さない。
   * Codex の駆動役は渡さない（渡していないことを note に残す）。作業者（`agents`）には足さない。
   */
  plugins?: readonly AgentClonePlugin[];
  sessionLog: AgentSessionLog;
  spawnProcess?: AgentSpawnProcess;
  onPermission: AgentPermissionHandler;
  // `permission_denied` として数えない: クローンが判断していないものを数えると、拒否の累積・通知に嘘が混ざるため
  onNote?: (text: string) => void;
  onPreToolUse: AgentPreToolHook;
  onPermissionDenied: AgentPermissionDeniedHook;
  onPostToolUse: AgentContextHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
  onPreCompact: AgentObservationHook<AgentPreCompactRecord>;
  onUserPromptSubmit: AgentObservationHook<AgentUserPromptSubmitRecord>;
  onSubagentStop: AgentContextHook<AgentSubagentStopRecord>;
  onStop: AgentObservationHook<AgentStopRecord>;
}

export interface AgentManagerDriver {
  readonly providerId: AgentProviderId;
  open(spec: AgentManagerSessionSpec): AgentManagerSession;
}
