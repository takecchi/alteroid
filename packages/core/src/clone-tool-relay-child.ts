import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';

// **互換のための re-export。** 既存のテスト（`clone-tool-relay-host.test.ts` /
// `clone-tool-relay-integration.test.ts`）はこのファイルからこの2つの名前を
// import している——本体は `clone-tool-relay-protocol.ts`（doc はそちら）へ
// 移したが、import 元は変えずに済むようここでも同じ名前を見せる。
export { CLONE_TOOL_RELAY_SOCKET_ENV, CLONE_TOOL_RELAY_TOKEN_ENV };

/**
 * SDK が「クローンの道具」の stdio MCP サーバとして spawn する子プロセスの
 * 入口（Issue #486 48(a)、案D「中継（relay）」）。
 *
 * ## 案D — なぜバイトを流すだけにするか
 *
 * 道具の実装（`createCloneMcpServer` が返す `McpServer` インスタンス）・
 * `ToolContext` の12本の closure・`self_dropped` が読むモジュール状態
 * （`dropped-record.ts`）・記憶ストアの接続は、**全部デーモンのプロセスに
 * 残す**（`clone-tool-relay-host.ts`）。この子プロセスは MCP のメッセージを
 * 1つも解釈しない —— stdin をソケットへ、ソケットを stdout へ、そのまま
 * 流すだけである。MCP の stdio 枠組みは改行区切りの JSON-RPC
 * （`@modelcontextprotocol/sdk` の `shared/stdio.ts`。`ReadBuffer` の実装で
 * 確認済み）なので、中身を1バイトも解釈せずに中継しても壊れない。
 *
 * これにより、`ToolContext` の同期→非同期化も、`self_dropped` の
 * （プロセスが変わることによる）意味の反転も発生しない——旧「案B（RPC橋で
 * `ToolContext` の全欄を越境させる）」に対して、この子プロセスが優れる点。
 *
 * ## 起動直後に token を送る
 *
 * デーモン側（`clone-tool-relay-host.ts` の `register()`）が発行した合鍵
 * token を、接続直後の最初の1行として送る。デーモンがそれを読み終えた後は
 * 双方向の素通しになる——`runner-protocol.ts` が持つ「デーモン⇄runner」の
 * 合鍵の意匠を、最小限だけ流用したもの（あちらは HTTP の Bearer、こちらは
 * 中継の最初の1行）。
 *
 * **環境変数の名前2本（`CLONE_TOOL_RELAY_SOCKET_ENV` /
 * `CLONE_TOOL_RELAY_TOKEN_ENV`）はこのファイルの外、`clone-tool-relay-protocol.ts`
 * に居る。** 理由はそちらの doc——`clone.ts` がこの2つの名前だけを import
 * すると、tsup がこのモジュール全体を共有チャンクへ括り出し、下の
 * `invokedDirectly()` が永久に偽になる事故が起きる。
 */

/** テストが差し替えられるように、標準入出力を引数として受け取る。 */
export interface CloneToolRelayChildIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

/**
 * 中継の本体。**ソケットへの接続方法も差し替え可能にしてある**——単体テストは
 * 実ソケットの代わりに疑似の双方向ストリームを渡せる。既定は `node:net` の
 * `createConnection`（Unix ドメインソケット）。
 *
 * @returns ソケットが閉じた（＝デーモン側が中継を終えた、または落ちた）ら
 *   解決する。エラーで閉じた場合も含めて解決する（例外を投げない）——
 *   呼び出し側（`invokedDirectly()` の下）が exit code を決める。
 */
export async function runCloneToolRelayChild(
  env: NodeJS.ProcessEnv,
  io: CloneToolRelayChildIo,
  connect: (socketPath: string) => NodeJS.ReadWriteStream = (socketPath) =>
    createConnection({ path: socketPath }),
): Promise<void> {
  const socketPath = env[CLONE_TOOL_RELAY_SOCKET_ENV];
  const token = env[CLONE_TOOL_RELAY_TOKEN_ENV];
  if (socketPath === undefined || socketPath === '') {
    throw new Error(`${CLONE_TOOL_RELAY_SOCKET_ENV} が渡っていない`);
  }
  if (token === undefined || token === '') {
    throw new Error(`${CLONE_TOOL_RELAY_TOKEN_ENV} が渡っていない`);
  }

  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`${token}\n`);

  // **`pipe()` に任せる。** バックプレッシャ（片方が詰まったらもう片方も
  // 止める）は Node のストリームが自前で処理する——手で `on('data', ...)` を
  // 書くと、そこを自分で再実装する必要が生まれる。
  io.stdin.pipe(socket);
  socket.pipe(io.stdout);

  await new Promise<void>((resolve) => {
    socket.once('close', resolve);
    socket.once('error', resolve);
  });
}

/** `apps/runner/src/index.ts` 等と同じ判別（このファイルが直接起動されたか）。 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCloneToolRelayChild(process.env, { stdin: process.stdin, stdout: process.stdout }).catch(
    (error: unknown) => {
      process.stderr.write(`alteroid-clone-tool-relay: ${String(error)}\n`);
      process.exit(1);
    },
  );
}
