import { join } from 'node:path';

import {
  createPeerSocketHost,
  DEFAULT_PEER_SOCKET_DIR,
  PEER_PROVIDER_IDS,
  PEER_SOCKET_FILENAME,
  resolvePeerModels,
  type AgentProviderId,
  type PeerSocketHost,
  type RunnerChildUser,
} from '@alteroid/core';

/**
 * マネージャーの peer 専用ソケットを開く口と、名指しできるモデル（#4118）。
 *
 * **ここではソケットを開かない。** 開く条件は Codex の資格がこの器に届いたことで、資格はデーモンが繋いで
 * 降ろす（起動の後に届く。ログインはさらに後のこともある）。Host が資格の到着を見て、初めて開くときに
 * {@link PeerSocketPlan.openSocket} を1回だけ呼ぶ。資格が1度も届かない器にはソケットを作らない。
 */
export interface PeerSocketPlan {
  readonly openSocket: () => Promise<PeerSocketHost>;
  /** provider ごとに人間が開けたモデル名（#3934。`ALTEROID_MANAGER_PEER_<PROVIDER>_MODELS`）。 */
  readonly models: Partial<Record<AgentProviderId, readonly string[]>>;
  readonly notices: readonly string[];
}

export function planPeerSocket(
  env: NodeJS.ProcessEnv,
  childUser: RunnerChildUser | undefined,
  dir: string = DEFAULT_PEER_SOCKET_DIR,
): PeerSocketPlan {
  // 綴りの不正は起動時に止める（資格が届いてからでは、誰も見ていないところで落ちる）
  const models = resolvePeerModels(env);
  const notices = PEER_PROVIDER_IDS.map((provider) => {
    const open = models[provider];
    return (
      `alteroid-runner: peer（${provider}）は、${provider} の資格（ログインか CODEX_API_KEY）が` +
      `この器に届いたら開きます（再起動は要りません）。` +
      (open === undefined
        ? `名指しできるモデル: 無し（${provider} の既定で動く）`
        : `名指しできるモデル: ${open.join(', ')}`)
    );
  });
  return {
    openSocket: () =>
      createPeerSocketHost({
        socketPath: join(dir, PEER_SOCKET_FILENAME),
        ...(childUser === undefined
          ? {}
          : { childUser: { uid: childUser.uid, gid: childUser.gid } }),
      }),
    models,
    notices,
  };
}
