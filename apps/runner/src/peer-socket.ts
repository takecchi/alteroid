import { join } from 'node:path';

import {
  createPeerSocketHost,
  DEFAULT_PEER_SOCKET_DIR,
  MANAGER_PEERS_ENV_KEY,
  PEER_SOCKET_FILENAME,
  resolvePeers,
  type AgentProviderId,
  type PeerSocketHost,
  type RunnerChildUser,
} from '@alteroid/core';

export interface PeerSocketOpening {
  readonly host: PeerSocketHost | undefined;
  readonly peers: readonly AgentProviderId[];
  readonly notices: readonly string[];
}

export async function openPeerSocket(
  env: NodeJS.ProcessEnv,
  managerProvider: AgentProviderId,
  childUser: RunnerChildUser | undefined,
  dir: string = DEFAULT_PEER_SOCKET_DIR,
): Promise<PeerSocketOpening> {
  const { peers, selfListed } = resolvePeers('manager', env, managerProvider);
  const notices: string[] = [];
  if (selfListed) {
    notices.push(
      `alteroid-runner: ${MANAGER_PEERS_ENV_KEY} に自分の層の provider（${managerProvider}）が` +
        `書かれています。「もう一方」ではないので呼ぶ対象から外しました`,
    );
  }
  if (peers.size === 0) return { host: undefined, peers: [], notices };
  const host = await createPeerSocketHost({
    socketPath: join(dir, PEER_SOCKET_FILENAME),
    ...(childUser === undefined ? {} : { childUser: { uid: childUser.uid, gid: childUser.gid } }),
  });
  const list = [...peers];
  notices.push(
    `alteroid-runner: マネージャーが呼べる provider: ${list.join(', ')}` +
      `（peer 用ソケット ${host.socketPath}）`,
  );
  return { host, peers: list, notices };
}
