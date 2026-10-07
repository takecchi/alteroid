import type { SdkFailure } from './sdk-failure.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { UsageTotals } from './usage.js';

export interface AgentRuntimeFacts {
  sessionId: string | null;
  model: string | null;
  agentVersion: string | null;
  apiKeySource: string | null;
  permissionMode: string | null;
  mcpServers: Array<{ name: string; status: string }> | null;
}

// 代用値を埋めない: 道具名や id が無いときの代用は層ごとに違うため
export interface AgentPermissionDenial {
  tool?: string;
  toolUseId?: string;
  input?: unknown;
  reason?: string;
  reasonType?: string;
  message?: string;
  agentId?: string;
  agentType?: string;
}

export type AgentContentBlock =
  { type: 'text'; text: string } | { type: 'tool_use'; name: string } | { type: 'other' };

export interface AgentTurnUsage {
  models: Record<string, UsageTotals>;
  sessionId?: string;
  mainLoopUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface AgentSessionStarted {
  type: 'session_started';
  sessionId: string;
  runtime: AgentRuntimeFacts;
}

// 別の枝にしない: 層が消費を積む前に読むか後に読むかを自分で決めており、揃えると日誌へ書く順が変わるため
export interface AgentPermissionDeniedEvent {
  type: 'permission_denied';
  via: 'live';
  denial: AgentPermissionDenial;
}

export interface AgentUsageNoticeEvent {
  type: 'usage_notice';
  notice: UsageLimitNotice;
}

export interface AgentRateLimitEvent {
  type: 'rate_limit';
  facts: RateLimitFacts;
}

export interface AgentTextDelta {
  type: 'text_delta';
  text: string;
}

export interface AgentAssistantMessage {
  type: 'assistant_message';
  parentToolUseId: string | null;
  blocks: readonly AgentContentBlock[];
  id?: string;
  errorCode?: string;
}

export interface AgentToolResult {
  type: 'tool_result';
}

export interface AgentDelegationStarted {
  type: 'delegation_started';
  taskId?: string;
  // 絞らず string のまま運ぶ: SDK が値を増やしても、知らない値は読み手の判定で「作業者ではない」側へ倒れるため
  taskType?: string;
  spawnDepth?: number;
}

export interface AgentDelegationNotified {
  type: 'delegation_notified';
  taskId?: string;
  // 絞らず string のまま運ぶ: 握り潰すと「取れなかった」と「'failed' ではない」が区別できなくなるため
  status?: string;
  summary?: string;
  outputFile?: string;
}

export interface AgentBackgroundTasksEvent {
  type: 'background_tasks';
  tasks: readonly { id: string; taskType: string }[];
}

export interface AgentCompactionEvent {
  type: 'compaction';
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens?: number;
}

export interface AgentTurnEnded {
  type: 'turn_ended';
  succeeded: boolean;
  failure?: SdkFailure;
  body: string;
  outcome?: string;
  errorLines: readonly string[];
  usage?: AgentTurnUsage;
  id?: string;
  denials: readonly AgentPermissionDenial[];
}

export type AgentEvent =
  | AgentSessionStarted
  | AgentPermissionDeniedEvent
  | AgentUsageNoticeEvent
  | AgentRateLimitEvent
  | AgentTextDelta
  | AgentAssistantMessage
  | AgentToolResult
  | AgentDelegationStarted
  | AgentDelegationNotified
  | AgentBackgroundTasksEvent
  | AgentCompactionEvent
  | AgentTurnEnded;
