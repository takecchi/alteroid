import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { noteBackgroundFailure } from './dropped-record.js';

/**
 * クローンの道具（MCP サーバ）を、中継の子プロセス（`clone-tool-relay-child.ts`。
 * バイトを流すだけで MCP も道具も DB も知らない）越しに接げるようにする、
 * デーモン側のソケット待ち受け（Issue #486 48(a)、案D）。
 *
 * ## 案D の要点
 *
 * 道具の実装（`createCloneMcpServer` が返す `McpServer` インスタンス）・
 * `ToolContext` の12本の closure・`self_dropped` のモジュール状態・記憶
 * ストアの接続は**全部このプロセス（デーモン）に残る**。子プロセスが最初の
 * 1行で送ってくる token を、事前に {@link register} された同じ token の
 * `McpServer` ファクトリと突き合わせ、一致したらその `instance` を
 * `new StdioServerTransport(socket, socket)` へ `connect()` する。
 * **以後このソケットが運ぶバイトは、そのまま MCP の JSON-RPC（改行区切り）に
 * なる**——中継そのものはここでは何もしない（`StdioServerTransport` が
 * `socket` を直接読み書きする）。
 *
 * これにより、`ToolContext` の12本を非同期の越境点へ書き換える必要も、
 * `self_dropped` が読む `recentDroppedTraces()`（モジュール配列）を
 * プロセスをまたいで運ぶ必要も生じない——旧「案B（RPC 橋で `ToolContext`
 * の全欄を線の向こうへ出す）」に対してこの設計が優れる理由である。
 *
 * ## このファイルが配線しないもの
 *
 * このモジュールは `register()` / `close()` を提供するだけで、**クローンの
 * セッション開始点（`clone.ts`）からは呼ばれていない**（Issue #486 の PR1の
 * 範囲——既定の挙動は1バイトも変わらない）。ソケットの本番の置き場
 * （`/run/alteroid/...` 相当）を決めるのも、`socketPath` を呼び出し側から
 * 渡させているこの関数の外の仕事である。
 */
export interface CloneToolRelayHost {
  /** listen しているソケットの絶対パス。 */
  readonly socketPath: string;
  /**
   * 1回分の接続を予約する。**token は使い捨て**——一致する接続が1本来たら
   * 消費し、以後同じ token では二度と繋げない（一致しない接続は即切断する。
   * 下の {@link readToken} の doc）。
   *
   * 子プロセスが繋がらないまま `options.timeoutMs`（既定
   * {@link DEFAULT_REGISTRATION_TIMEOUT_MS}）が過ぎたら、予約は自動で
   * 失効する——`close()` を呼ばない限りマップに溜まり続けるのを防ぐ。
   *
   * `mcpServer` を**ファクトリ**（`() => McpServer`）で受けるのは、子が
   * 実際に繋いでくるまで `McpServer`（＝道具・`ToolContext` を含む重い
   * 構築）を作らずに済ませるためである。
   *
   * @returns 子プロセスへ `ALTEROID_CLONE_TOOL_RELAY_TOKEN`
   *   （`clone-tool-relay-child.ts`）として渡す token。
   */
  register(mcpServer: () => McpServer, options?: { timeoutMs?: number }): string;
  /**
   * listen をやめ、ソケットファイルを消す。未消費の予約はすべて捨てる
   * （その予約に対応する `McpServer` は一度も作られていないので、後始末は
   * 不要）。
   */
  close(): void;
}

/** 子が来ないまま予約を保持する上限（ミリ秒）。 */
export const DEFAULT_REGISTRATION_TIMEOUT_MS = 30_000;

interface PendingRegistration {
  mcpServer: () => McpServer;
  timer: NodeJS.Timeout;
}

/**
 * 中継の待ち受けを開く。**listen とソケットの mode 0600 への絞り込みが
 * 終わるまで解決しない**（`await` すれば「まだ listen していないソケットへ
 * 繋ぎに行く」競合が起きない——`register()` を呼ぶ・`socketPath` を子プロセスへ
 * 渡して spawn する、はどちらもこの Promise の後で行うこと）。
 *
 * mode 0600 は `apps/runner/src/index.ts` が `ALTEROID_RUNNER_SOCKET` に
 * 対してしていることと同じ形（「デーモンだけが繋げる持ち主にする」）。**同一
 * UID の別プロセスからは今日も読める**——クローンの子プロセス
 * （`buildCloneSessionOptions`）には `spawnClaudeCodeProcess`（`childUser`）が
 * 配線されておらず、デーモンと同じ UID で走るため（`claude-provider.ts` の
 * `buildManagerSessionOptions` にだけ在ることを実測済み）。UID を跨いで守る
 * 形は、このPRの範囲外である。
 *
 * ## ⚠️ listen〜chmod の窓（PR1 の留保）を、ディレクトリ側でも塞ぐ
 *
 * `chmodSync(socketPath, 0o600)`（下）は `listen()` が返った**後**にしか
 * 呼べない——その一瞬、ソケットファイル自体は作成時の既定の mode のままである。
 * **ここでは加えて、ソケットを収めるディレクトリを先に 0700 にする**
 * （`mkdirSync(dir, { recursive: true, mode: 0o700 })` の直後に、既存の
 * ディレクトリだった場合に備えて `chmodSync(dir, 0o700)` も呼ぶ——`mkdirSync` の
 * `mode` は「新規に作った」ときにしか効かない）。ディレクトリが 0700 なら、
 * 同じ UID 以外はそもそもそこへ `traverse`（`x` 権限）できないので、**中の
 * ソケットファイル自身がまだ緩い mode のままの一瞬があっても、辿り着けない
 * 側から見れば窓が無い**——ソケット単体の chmod と二重に塞ぐ形になる。
 */
export async function createCloneToolRelayHost(options: {
  socketPath: string;
}): Promise<CloneToolRelayHost> {
  const { socketPath } = options;
  const pending = new Map<string, PendingRegistration>();

  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 既存のディレクトリだった場合に備える——`mkdirSync` の `mode` は新規作成の
  // ときにしか適用されない（既存なら黙って何もしない）。
  chmodSync(dir, 0o700);

  // 古いソケットが残っていると listen できない（器の作り直しで残る。
  // `apps/runner/src/index.ts` と同じ手当て）。
  rmSync(socketPath, { force: true });

  const server: Server = createServer((socket) => {
    handleConnection(socket).catch((error: unknown) => {
      noteBackgroundFailure('clone-tool-relay の接続', '', error);
      socket.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);

  async function handleConnection(socket: Socket): Promise<void> {
    const token = await readToken(socket);
    if (token === undefined) return; // 改行が来る前に切断された
    const found = pending.get(token);
    if (found === undefined) {
      socket.destroy();
      return;
    }
    pending.delete(token);
    clearTimeout(found.timer);
    const instance = found.mcpServer();
    await instance.connect(new StdioServerTransport(socket, socket));
    // **ここで `resume()` する。** `readToken` が `pause()` したまま渡してくる
    // （下の doc）——`StdioServerTransport.start()`（`connect()` の中）が
    // 新しい `data` リスナーを張った**後**に自分で再開しない限り、
    // `pause()` 中に `unshift()` で押し戻した分（token の次の行以降、
    // 最初の MCP メッセージが同じ chunk に相乗りしていた場合はそれも含む）は
    // 二度と流れない。
    socket.resume();
  }

  return {
    socketPath,
    register(mcpServer, registerOptions) {
      const token = randomBytes(32).toString('hex');
      const timeoutMs = registerOptions?.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(token);
      }, timeoutMs);
      timer.unref();
      pending.set(token, { mcpServer, timer });
      return token;
    },
    close() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      server.close();
      rmSync(socketPath, { force: true });
    },
  };
}

/**
 * ソケットから改行までを1行読み、token として返す。**それより後に届いた
 * バイトは `socket.unshift()` で押し戻す**——呼び出し側が新しい消費者
 * （`StdioServerTransport`）を繋いだ後 `socket.resume()` すれば、押し戻した分が
 * 最初の `data` として届く。1バイトも失わない。
 *
 * 改行が来る前にソケットが閉じた・エラーになったら `undefined` を返す
 * （`handleConnection` はそのまま何もしない——子が起動直後に落ちた場合等）。
 *
 * ## ⚠️ `cleanup()` は `socket.pause()` を呼ぶ。**呼び出し側が
 * `socket.resume()` するまで、ソケットは意図して止まったままになる**
 *
 * 理由は「新しい消費者が `data` リスナーを張るまでの隙で、届いたバイトを
 * 失わない」ため——両端を測って初めて分かった、Node のストリームが持つ
 * 2つの罠の組み合わせである（実測。`clone-tool-relay-host.test.ts` の
 * `tools/list` が両方の順で一度ずつ 5秒タイムアウトした）:
 *
 * 1. **`pause()` しなければ、新しい消費者が繋がるまでの隙でバイトが消える。**
 *    最後の `data` リスナーを外しても `flowing` は自動では戻らない
 *    （Node は「`data`/`readable` リスナーが0本になったら pause する」までは
 *    しない）。`flowing === true` のまま listener が0本の状態は、Node 公式
 *    doc が明示的に警告している「データを失う」形そのもの——内部の読み出し
 *    ループが `read()` を呼び続け、`emit('data', chunk)` した先に誰も居ない。
 *    `unshift()` で押し戻した分もこの経路で溶ける
 * 2. **かといって `pause()` したまま放置すると、今度は新しい消費者が
 *    `data` リスナーを張っても2度と再開しない。** `Readable#on('data', …)`
 *    が自動で `resume()` するのは `state.flowing !== false` のときだけで、
 *    `pause()` は `flowing` を明示的に `false` へ落とす。`false` はこの
 *    条件に当たらないので、`StdioServerTransport.start()` が新しい
 *    リスナーを張っても、誰も `resume()` を呼ばない限り一生流れない
 *
 * ⟹ **`pause()` してから `unshift()` し、新しい消費者を繋いだ「後」に
 * 呼び出し側（`handleConnection`）が明示的に `resume()` する**、の3手が
 * 揃って初めて両方の罠を避けられる。
 */
function readToken(socket: Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
      // 上の doc「罠1」を避ける——新しい消費者が繋がるまで、明示して止める。
      socket.pause();
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      const line = buffer.toString('utf8', 0, index).replace(/\r$/, '');
      const rest = buffer.subarray(index + 1);
      cleanup();
      if (rest.length > 0) socket.unshift(rest);
      resolve(line);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(undefined);
    };
    socket.on('data', onData);
    socket.on('close', onEnd);
    socket.on('error', onEnd);
  });
}
