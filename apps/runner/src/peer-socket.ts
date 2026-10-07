import { join } from 'node:path';

import {
  createPeerSocketHost,
  DEFAULT_AGENT_PROVIDER_ID,
  DEFAULT_PEER_SOCKET_DIR,
  MANAGER_PEERS_ENV_KEY,
  PEER_SOCKET_FILENAME,
  resolvePeerModels,
  resolvePeers,
  type AgentProviderId,
  type PeerSocketHost,
  type RunnerChildUser,
} from '@alteroid/core';

export interface PeerSocketOpening {
  readonly host: PeerSocketHost | undefined;
  readonly peers: readonly AgentProviderId[];
  /** provider ごとに人間が開けたモデル名（#3934。`ALTEROID_MANAGER_PEER_<PROVIDER>_MODELS`）。 */
  readonly models: Partial<Record<AgentProviderId, readonly string[]>>;
  readonly notices: readonly string[];
}

export async function openPeerSocket(
  env: NodeJS.ProcessEnv,
  childUser: RunnerChildUser | undefined,
  dir: string = DEFAULT_PEER_SOCKET_DIR,
): Promise<PeerSocketOpening> {
  // マネージャー層は常に Claude で動く（2026-10-07 の決定）。「もう一方」は Claude 以外である。
  const managerProvider = DEFAULT_AGENT_PROVIDER_ID;
  const { peers, selfListed } = resolvePeers(env, managerProvider);
  const notices: string[] = [];
  if (selfListed) {
    notices.push(
      `alteroid-runner: ${MANAGER_PEERS_ENV_KEY} に自分の層の provider（${managerProvider}）が` +
        `書かれています。「もう一方」ではないので呼ぶ対象から外しました`,
    );
  }
  // 綴りの不正はソケットを開く前に止める（起動時に止める。`parsePeers` と同じ作法）。
  const { models, unusedKeys } = resolvePeerModels(env, peers);
  for (const key of unusedKeys) {
    notices.push(
      `alteroid-runner: ${key} が置かれていますが、その provider は ${MANAGER_PEERS_ENV_KEY} で開いていないので使いません`,
    );
  }
  if (peers.size === 0) return { host: undefined, peers: [], models: {}, notices };
  const host = await createPeerSocketHost({
    socketPath: join(dir, PEER_SOCKET_FILENAME),
    ...(childUser === undefined ? {} : { childUser: { uid: childUser.uid, gid: childUser.gid } }),
  });
  const list = [...peers];
  notices.push(
    `alteroid-runner: マネージャーが呼べる provider: ${list.join(', ')}` +
      `（peer 用ソケット ${host.socketPath}）`,
  );
  for (const provider of list) {
    const open = models[provider];
    notices.push(
      open === undefined
        ? `alteroid-runner: peer（${provider}）で名指しできるモデル: 無し（${provider} の既定で動く）`
        : `alteroid-runner: peer（${provider}）で名指しできるモデル: ${open.join(', ')}`,
    );
  }
  return { host, peers: list, models, notices };
}
