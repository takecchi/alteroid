import type { AgentProvider } from './agent-ports.js';

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
};

// permissions を false にする: クローンの Codex は approvalPolicy=never で走り、確認の代用を出さないため
export const CODEX_CLONE_PROVIDER: AgentProvider = {
  ...CODEX_PROVIDER,
  capabilities: {
    ...CODEX_PROVIDER.capabilities,
    permissions: false,
    compactionHook: false,
  },
};
