import { AGENT_PROVIDER_IDS, type AgentProviderId } from './agent-ports.js';
import { placedAgentProvider } from './agent-provider-selection.js';

export const MANAGER_PEERS_ENV_KEY = 'ALTEROID_MANAGER_PEERS';

export interface PeersResolution {
  readonly peers: ReadonlySet<AgentProviderId>;
  readonly selfListed: boolean;
}

export function parsePeers(
  raw: string | undefined,
  selfProvider: AgentProviderId,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeersResolution {
  const key = MANAGER_PEERS_ENV_KEY;
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
    // 自分の層の provider を例外にしない: 無害な値のために起動が止まるため
    if (id === selfProvider) {
      selfListed = true;
      continue;
    }
    peers.add(id);
  }
  return { peers, selfListed };
}

export function resolvePeers(
  env: NodeJS.ProcessEnv,
  selfProvider: AgentProviderId,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeersResolution {
  return parsePeers(env[MANAGER_PEERS_ENV_KEY], selfProvider, known);
}

export function isPeerAllowed(
  selfProvider: AgentProviderId,
  peers: ReadonlySet<AgentProviderId>,
  target: AgentProviderId,
): boolean {
  return target !== selfProvider && peers.has(target);
}
