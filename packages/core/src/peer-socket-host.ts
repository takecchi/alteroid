import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';

/**
 * マネージャー層の MCP `peer` を、マネージャーの子プロセス（別 UID）から繋げる runner の peer 専用ソケット。
 *
 * peer 専用: 向こうに居るのは `register()` の `McpServer` だけで、runner の制御面には繋げない。
 * 守りの本体は使い捨ての token であって、ファイルの権限ではない: ソケットは子の UID 持ちの 0600 だが、
 * 同じ UID の別プロセス（作業者など）からもファイル自体には届く。
 * Codex の資格が1度も届かない器ではソケットを開かない（届いたときに runner の Host が開く）。
 */
export const DEFAULT_PEER_SOCKET_DIR = '/run/alteroid/peer';
export const PEER_SOCKET_FILENAME = 'peer.sock';

export const PEER_TOKEN_TIMEOUT_MS = 30_000;

export type PeerSocketHost = CloneToolRelayHost;

export async function createPeerSocketHost(options: {
  socketPath: string;
  childUser?: { uid: number; gid: number };
}): Promise<PeerSocketHost> {
  const host = await createCloneToolRelayHost({
    socketPath: options.socketPath,
    dirMode: 0o711,
    ...(options.childUser === undefined ? {} : { socketOwner: options.childUser }),
  });
  return {
    socketPath: host.socketPath,
    register(mcpServer: () => McpServer, registerOptions) {
      return host.register(mcpServer, { timeoutMs: PEER_TOKEN_TIMEOUT_MS, ...registerOptions });
    },
    close: () => host.close(),
  };
}
