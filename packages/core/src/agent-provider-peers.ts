import { AGENT_PROVIDER_IDS, type AgentProviderId } from './agent-ports.js';
import { placedAgentProvider } from './agent-provider-selection.js';
import type { ProviderGapLayer } from './provider-gaps.js';

export const CLONE_PEERS_ENV_KEY = 'ALTEROID_CLONE_PEERS';
export const MANAGER_PEERS_ENV_KEY = 'ALTEROID_MANAGER_PEERS';

export type PeersLayer = Exclude<ProviderGapLayer, 'worker'>;

const PEERS_ENV_KEY: Record<PeersLayer, string> = {
  clone: CLONE_PEERS_ENV_KEY,
  manager: MANAGER_PEERS_ENV_KEY,
};

export function peersEnvKeyOf(layer: PeersLayer): string {
  return PEERS_ENV_KEY[layer];
}

export interface PeersResolution {
  readonly peers: ReadonlySet<AgentProviderId>;
  readonly selfListed: boolean;
}

export function parsePeers(
  layer: PeersLayer,
  raw: string | undefined,
  selfProvider: AgentProviderId,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeersResolution {
  const key = PEERS_ENV_KEY[layer];
  const given = placedAgentProvider({ [key]: raw }, key);
  const peers = new Set<AgentProviderId>();
  let selfListed = false;
  if (given === null) return { peers, selfListed };
  for (const part of given.split(',')) {
    const name = part.trim();
    if (name.length === 0) {
      throw new Error(
        `${key} の値が不正: ${given}（空の要素がある。カンマ区切りで provider 名を書く）`,
      );
    }
    const id = known.find((candidate) => candidate === name);
    if (id === undefined) {
      throw new Error(`${key} の値が不正: ${name}（使えるのは ${known.join(' / ')}）`);
    }
    // 自分の層の provider を例外にしない: 両方の層に同じ値を書く運用や provider の入れ替えで、無害な値のために起動が止まるため
    if (id === selfProvider) {
      selfListed = true;
      continue;
    }
    peers.add(id);
  }
  return { peers, selfListed };
}

export function resolvePeers(
  layer: PeersLayer,
  env: NodeJS.ProcessEnv,
  selfProvider: AgentProviderId,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeersResolution {
  return parsePeers(layer, env[PEERS_ENV_KEY[layer]], selfProvider, known);
}

export function isPeerAllowed(
  selfProvider: AgentProviderId,
  peers: ReadonlySet<AgentProviderId>,
  target: AgentProviderId,
): boolean {
  return target !== selfProvider && peers.has(target);
}
