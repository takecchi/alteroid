import type { AgentProvider } from './agent-ports.js';

/**
 * `ALTEROID_MANAGER_PEER_CODEX_MODELS` が未設定・空のときに `peer_run` で名指しできる Codex のモデル。
 * 新しいモデルを開くときはここだけを直す。単価表（`codex-pricing.ts`）に無いモデルは入れない（費用を「単価不明」にしか出せないため）。
 * 古い帯・安い帯は入れない: 既定で並べると、頼む側が理由なく下の帯を選べる形になるため。
 */
export const CODEX_DEFAULT_PEER_MODELS: readonly string[] = ['gpt-6-astra', 'gpt-6.1-sol'];

// 実装で満たしているものだけを true にする: 持たない能力を持つふりをしないため。mcpServers は実機の app-server で繋がることが未確認なので false のまま
export const CODEX_PROVIDER: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: {
    permissions: true,
    toolAudit: true,
    compactionHook: false,
    resume: true,
    sessionLog: false,
    subagents: false,
    mcpServers: false,
    childUser: true,
    usage: true,
    partialMessages: true,
  },
  defaultPeerModels: CODEX_DEFAULT_PEER_MODELS,
};
