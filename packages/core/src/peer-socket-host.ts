import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';

/**
 * マネージャー層の MCP `peer`（`peer_run` / `peer_reply`。Issue #486 S7）を、マネージャーの
 * 子プロセス（別 UID。`ALTEROID_RUNNER_CHILD_UID`）から繋げるための、runner の peer 専用ソケット。
 *
 * ## 安全の線（オーナー決定。ここから外れない）
 *
 * - **peer 専用**。このソケットの向こうに居るのは `register()` で渡された `McpServer` だけで、
 *   runner の制御面（HTTP の `ALTEROID_RUNNER_SOCKET`）にも合鍵にも繋がらない。
 *   制御用ソケットは今までどおり 1001 に届かない（別のファイル・別の持ち主）。
 * - **守りの本体はセッションごとの使い捨ての token**（`randomBytes(32)`。接続に1回使うと消え、
 *   {@link PEER_TOKEN_TIMEOUT_MS} で失効し、一致しない接続は即切断する）。
 * - ソケットは子の UID だけを持ち主にした 0600、置き場所のディレクトリは 0711（root の持ち物）。
 *   **⚠ 同じ 1001 の別プロセス（作業者など）からも、ソケットファイル自体には届く。**
 *   守りは token であって、ファイルの権限ではない。
 * - Codex の資格（ChatGPT ログインか `CODEX_API_KEY`）が1度も届かない器では、このソケットは開かない
 *   （資格が初めて届いたときに runner の Host が開く。`runner.ts` の `#refreshPeers`。#4118）。
 *
 * 中身の仕組み（最初の1行で token を送る・MCP の素通し）は `clone-tool-relay-host.ts` と同じ。
 * 子プロセスは既存の `clone-tool-relay-child`（バイトを流すだけ）を使い回せる。
 */
export const DEFAULT_PEER_SOCKET_DIR = '/run/alteroid/peer';
export const PEER_SOCKET_FILENAME = 'peer.sock';

/** 子が来ないまま token を保持する上限。 */
export const PEER_TOKEN_TIMEOUT_MS = 30_000;

/** peer の口。{@link CloneToolRelayHost} と同じ形で、`register` の token が使い捨てである。 */
export type PeerSocketHost = CloneToolRelayHost;

export async function createPeerSocketHost(options: {
  socketPath: string;
  /** 降ろした子の UID/GID。ローカル実行（子が別 UID でない）では省略する。 */
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
