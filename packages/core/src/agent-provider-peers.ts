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

/**
 * peer の provider ごとに、人間が開けたモデル名の一覧を置く環境変数の名前（#3934）。
 * Codex なら `ALTEROID_MANAGER_PEER_CODEX_MODELS`（カンマ区切り）。
 * **provider ごとに分ける**: モデル名は provider の語彙なので、1本の一覧に混ぜると
 * どの provider のモデルか判別できなくなる。
 */
export function managerPeerModelsEnvKey(provider: AgentProviderId): string {
  return `ALTEROID_MANAGER_PEER_${provider.toUpperCase()}_MODELS`;
}

/** {@link managerPeerModelsEnvKey} の Codex の名前（`.env.example` / `compose.yaml` と突き合わせる）。 */
export const MANAGER_PEER_CODEX_MODELS_ENV_KEY = 'ALTEROID_MANAGER_PEER_CODEX_MODELS';

/**
 * モデル名の一覧を解く。未設定・空・空白だけは空（`model` 引数を出さない）。
 * **綴りの不正（空の要素）は起動時に止める**（{@link parsePeers} と同じ作法）。重複は1つに畳む。
 */
export function parsePeerModels(raw: string | undefined, key: string): string[] {
  const given = raw?.trim() ?? '';
  if (given.length === 0) return [];
  const models: string[] = [];
  for (const part of given.split(',')) {
    const name = part.trim();
    if (name.length === 0) {
      throw new Error(
        `${key} の値が不正: ${given}（空の要素がある。カンマ区切りでモデル名を書く）`,
      );
    }
    if (/\s/.test(name)) {
      throw new Error(`${key} の値が不正: ${name}（モデル名に空白は入らない）`);
    }
    if (!models.includes(name)) models.push(name);
  }
  return models;
}

export interface PeerModelsResolution {
  readonly models: Partial<Record<AgentProviderId, readonly string[]>>;
  /** 一覧が置かれているのに、その provider が PEERS で開いていない（使われない）。 */
  readonly unusedKeys: readonly string[];
}

/** 開いている peer ごとにモデルの一覧を解く。開いていない provider の一覧は使わずに名前を返す。 */
export function resolvePeerModels(
  env: NodeJS.ProcessEnv,
  peers: ReadonlySet<AgentProviderId>,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeerModelsResolution {
  const models: Partial<Record<AgentProviderId, readonly string[]>> = {};
  const unusedKeys: string[] = [];
  for (const provider of known) {
    const key = managerPeerModelsEnvKey(provider);
    const list = parsePeerModels(env[key], key);
    if (list.length === 0) continue;
    if (!peers.has(provider)) {
      unusedKeys.push(key);
      continue;
    }
    models[provider] = list;
  }
  return { models, unusedKeys };
}
