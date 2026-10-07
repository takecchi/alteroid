export interface AgentToolAuditRecord {
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  effortLevel?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface AgentToolAuditFailureRecord {
  toolName?: string;
  toolInput?: unknown;
  transcriptPath?: string;
  effortLevel?: string;
  agentId?: string;
  agentType?: string;
  error?: string;
  isInterrupt?: boolean;
  toolUseId?: string;
}

export interface AgentPreCompactRecord {
  transcriptPath?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AgentUserPromptSubmitRecord {
  agentId?: string;
  source?: string;
}

export interface AgentStopRecord {
  // unknown のまま運ぶ: 中身の形は provider ごとに違いうるため
  backgroundTasks?: unknown[];
  sessionCrons?: unknown[];
  stopHookActive?: boolean;
  readError?: unknown;
}

export type AgentObservationHook<T> = (record: T) => void | Promise<void>;

export interface AgentPreToolRecord {
  toolName?: string;
  toolInput?: unknown;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

// deny を既定にしない: 確認に上げないので、誰も開けられないため
export type AgentPreToolDecision =
  | { kind: 'continue'; rewrite?: AgentPreToolRewrite }
  | { kind: 'allow'; reason: string; rewrite?: AgentPreToolRewrite }
  | { kind: 'ask'; reason: string; rewrite?: AgentPreToolRewrite }
  | { kind: 'deny'; reason: string };

// input は差分ではなく全体: provider は元の入力をまるごと置き換えるため
export interface AgentPreToolRewrite {
  readonly input: Record<string, unknown>;
  readonly note: string;
}

export type AgentPreToolHook = (
  record: AgentPreToolRecord,
) => AgentPreToolDecision | Promise<AgentPreToolDecision>;

export interface AgentSubagentStopRecord {
  // unknown のまま運ぶ: 中身の形は provider ごとに違いうるため
  backgroundTasks?: unknown[];
  sessionCrons?: unknown[];
  agentId?: string;
  agentType?: string;
  stopHookActive?: boolean;
  readError?: unknown;
}

// AgentPreToolDecision を使い回さない: この2つのフックは実行を許可・拒否する口を持たないため
export type AgentContextOutcome = { kind: 'continue' } | { kind: 'addContext'; text: string };

export type AgentContextHook<T> = (record: T) => AgentContextOutcome | Promise<AgentContextOutcome>;

export interface AgentPermissionDeniedRecord {
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  reason?: string;
  agentId?: string;
  agentType?: string;
  signal?: AbortSignal;
}

export type AgentPermissionDeniedDecision = { kind: 'retry' } | { kind: 'no-retry' };

export type AgentPermissionDeniedHook = (
  record: AgentPermissionDeniedRecord,
) => Promise<AgentPermissionDeniedDecision>;
