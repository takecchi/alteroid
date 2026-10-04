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

/** peer の口の開き方の結果。 */
export interface PeerSocketOpening {
  /** 開いた口。PEERS が空なら `undefined`（ソケットも作らない）。 */
  readonly host: PeerSocketHost | undefined;
  /** 呼んでよい provider（空なら閉じている）。 */
  readonly peers: readonly AgentProviderId[];
  /** 起動時に表示する行（空配列なら何も言わない）。 */
  readonly notices: readonly string[];
}

/**
 * `ALTEROID_MANAGER_PEERS` が開いているときだけ、peer 専用ソケットを開く（#486 S7）。
 *
 * **空なら何もしない**（ソケットも作らず、起動の出力も増やさない。既定の挙動は変わらない）。
 * 不正な値は `resolvePeers` が例外にして起動を止める。
 * ソケットは子の UID だけを持ち主にする（`createPeerSocketHost`）。制御用ソケットとは別の口である。
 */
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
