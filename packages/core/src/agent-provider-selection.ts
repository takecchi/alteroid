import {
  AGENT_PROVIDER_IDS,
  DEFAULT_AGENT_PROVIDER_ID,
  type AgentProvider,
  type AgentProviderId,
} from './agent-ports.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { CODEX_CLONE_PROVIDER, CODEX_PROVIDER } from './codex-provider.js';
import { placedModelTier } from './model-tier.js';

export const CLONE_PROVIDER_ENV_KEY = 'ALTEROID_CLONE_PROVIDER';
export const MANAGER_PROVIDER_ENV_KEY = 'ALTEROID_MANAGER_PROVIDER';

export { DEFAULT_AGENT_PROVIDER_ID };

export function placedAgentProvider(env: NodeJS.ProcessEnv, key: string): string | null {
  return placedModelTier(env, key);
}

export const CLONE_PROVIDER_IDS: readonly AgentProviderId[] = ['claude', 'codex'];

export const CLONE_PROVIDER_RECOMMENDATION =
  'クローン層の provider は Claude を推奨する（Codex では承認と蒸留の2つが欠ける）';

export const MANAGER_PROVIDER_IDS: readonly AgentProviderId[] = ['claude', 'codex'];

function resolveAgentProviderId(
  env: NodeJS.ProcessEnv,
  key: string,
  accepted: readonly AgentProviderId[],
  note?: string,
): AgentProviderId {
  const given = placedAgentProvider(env, key);
  if (given === null) return DEFAULT_AGENT_PROVIDER_ID;
  const known = accepted.find((id) => id === given);
  if (known !== undefined) return known;
  // 未知の値を既定へ倒さない: 別の provider を効かせたかった人間が、効いていないことに気づけないため
  throw new Error(
    `${key} の値が不正: ${given}` +
      `（使えるのは ${accepted.join(' / ')}。既定は ${DEFAULT_AGENT_PROVIDER_ID}）` +
      (note === undefined ? '' : `。${note}`),
  );
}

export function resolveCloneProviderId(env: NodeJS.ProcessEnv = process.env): AgentProviderId {
  return resolveAgentProviderId(
    env,
    CLONE_PROVIDER_ENV_KEY,
    CLONE_PROVIDER_IDS,
    CLONE_PROVIDER_RECOMMENDATION,
  );
}

export function resolveManagerProviderId(env: NodeJS.ProcessEnv = process.env): AgentProviderId {
  return resolveAgentProviderId(env, MANAGER_PROVIDER_ENV_KEY, MANAGER_PROVIDER_IDS);
}

const AGENT_PROVIDERS: Record<AgentProviderId, AgentProvider> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

export function agentProviderOf(id: AgentProviderId): AgentProvider {
  return AGENT_PROVIDERS[id];
}

export function cloneLayerProviderOf(id: AgentProviderId): AgentProvider {
  return id === 'codex' ? CODEX_CLONE_PROVIDER : agentProviderOf(id);
}

export const CODEX_DEFAULT_MODEL_LABEL = 'Codex の既定のモデル';

export const CODEX_NO_WORKER_LABEL = 'なし（Codex に作業者層は無い）';

export function layerModelLabel(
  provider: AgentProviderId,
  claudeBand: string,
  placed: string | null,
): string {
  if (provider !== 'codex') return claudeBand;
  return placed ?? CODEX_DEFAULT_MODEL_LABEL;
}

export function knownProviderOf(id: string): AgentProvider | undefined {
  const known = AGENT_PROVIDER_IDS.find((candidate) => candidate === id);
  return known === undefined ? undefined : agentProviderOf(known);
}
