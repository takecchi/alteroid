import {
  DEFAULT_AGENT_PROVIDER_ID,
  type AgentProvider,
  type AgentProviderId,
} from './agent-ports.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { CODEX_PROVIDER } from './codex-provider.js';
import { placedModelTier } from './model-tier.js';

// 層の provider を選ぶ口は無い（2026-10-07 の決定。層は常に Claude）。ここは MCP `peer` が実体を引く表だけ

export { DEFAULT_AGENT_PROVIDER_ID };

export function placedAgentProvider(env: NodeJS.ProcessEnv, key: string): string | null {
  return placedModelTier(env, key);
}

const AGENT_PROVIDERS: Record<AgentProviderId, AgentProvider> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

export function agentProviderOf(id: AgentProviderId): AgentProvider {
  return AGENT_PROVIDERS[id];
}
