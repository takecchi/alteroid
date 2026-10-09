export type AgentProviderId = 'claude' | 'codex';

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = ['claude', 'codex'];

export const DEFAULT_AGENT_PROVIDER_ID: AgentProviderId = 'claude';

export interface AgentCapabilities {
  permissions: boolean;
  toolAudit: boolean;
  compactionHook: boolean;
  resume: boolean;
  sessionLog: boolean;
  subagents: boolean;
  mcpServers: boolean;
  childUser: boolean;
  usage: boolean;
  partialMessages: boolean;
}

export const NO_CAPABILITIES: AgentCapabilities = {
  permissions: false,
  toolAudit: false,
  compactionHook: false,
  resume: false,
  sessionLog: false,
  subagents: false,
  mcpServers: false,
  childUser: false,
  usage: false,
  partialMessages: false,
};

// partialMessages を含めない: 要件ではなく応答の見せ方（ストリーミング表示）でしかないため
export const REQUIREMENT_BEARING_CAPABILITIES: readonly (keyof AgentCapabilities)[] = [
  'permissions',
  'toolAudit',
  'compactionHook',
  'resume',
  'sessionLog',
  'subagents',
  'mcpServers',
  'childUser',
  'usage',
];

export function missingRequirementCapabilities(
  capabilities: AgentCapabilities,
): readonly (keyof AgentCapabilities)[] {
  return REQUIREMENT_BEARING_CAPABILITIES.filter((key) => !capabilities[key]);
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  /**
   * peer として呼ばれるとき、`ALTEROID_MANAGER_PEER_<PROVIDER>_MODELS` が未設定・空なら名指しできるモデル。
   * 無ければ、変数を置かない限り `model` 引数を出さない。
   */
  readonly defaultPeerModels?: readonly string[];
}
