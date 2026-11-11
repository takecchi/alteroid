export type AgentProviderId = 'claude' | 'codex';

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = ['claude', 'codex'];

export const DEFAULT_AGENT_PROVIDER_ID: AgentProviderId = 'claude';

// 旗は、どこかで読まれる物だけを置く。読む所の無い旗は、読む人が追う表を増やすだけで動きに効かない
export interface AgentCapabilities {
  /** 使用量（トークン・費用）を報告できるか。報告できない provider は計量しない（`clone-usage-ledger`・runner の `reportsUsage`）。 */
  usage: boolean;
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
