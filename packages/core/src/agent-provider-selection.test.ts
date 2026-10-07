import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS } from './agent-ports.js';
import {
  DEFAULT_AGENT_PROVIDER_ID,
  agentProviderOf,
  placedAgentProvider,
} from './agent-provider-selection.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { CODEX_PROVIDER } from './codex-provider.js';

describe('provider の登録簿', () => {
  it('既定は claude', () => {
    expect(DEFAULT_AGENT_PROVIDER_ID).toBe('claude');
  });

  it('agentProviderOf は id から AgentProvider を引く', () => {
    expect(agentProviderOf('claude')).toBe(CLAUDE_PROVIDER);
    expect(agentProviderOf('codex')).toBe(CODEX_PROVIDER);
    for (const id of AGENT_PROVIDER_IDS) expect(agentProviderOf(id).id).toBe(id);
  });
});

describe('placedAgentProvider', () => {
  it('置かれていなければ null（空・空白も未設定）', () => {
    expect(placedAgentProvider({}, 'ALTEROID_MANAGER_PEERS')).toBeNull();
    expect(
      placedAgentProvider({ ALTEROID_MANAGER_PEERS: ' ' }, 'ALTEROID_MANAGER_PEERS'),
    ).toBeNull();
  });

  it('置かれていれば前後の空白を落とした値', () => {
    expect(
      placedAgentProvider({ ALTEROID_MANAGER_PEERS: ' codex ' }, 'ALTEROID_MANAGER_PEERS'),
    ).toBe('codex');
  });
});
