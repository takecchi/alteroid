/**
 * デーモンと runner の間の HTTP の接続の使い回し（keep-alive）の長さ（#4890）。2つの値の大小が要点なので、同じ場所に置く。
 *
 * - クライアント（デーモン）は、心拍（`HEARTBEAT_INTERVAL_MS` = 10 秒）より長く接続を持つ: 心拍のたびに全 runner へ
 *   名前解決（libuv のスレッドの枠）と接続をやり直さないため。Node 同梱の fetch の既定は約4秒で、毎回やり直していた。
 * - サーバ（runner の node の http サーバ）は、クライアントより長く持つ: サーバのほうが先に閉じると、閉じる瞬間に
 *   クライアントが投げた要求が閉じかけの接続へ当たり、切れる。Node の既定は 5 秒で、クライアントの値より短い。
 *
 * 長命の接続（SSE の `/events`）には関係しない: keep-alive の持ち時間は、応答の合間に**待っているだけ**の接続にだけ掛かる。
 * 応答を流している最中の接続は、この時間では畳まれない。
 */
export const RUNNER_CLIENT_KEEP_ALIVE_MS = 30_000;
export const RUNNER_KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * `headersTimeout` を `keepAliveTimeout` より長くする: Node は、使い回し待ちの接続にも `headersTimeout` の見張りを掛けうる。
 * 短いままだと、keep-alive の持ち時間より先に接続が畳まれる。1 秒の差は Node の見張りの粒度（約1秒）を越えるための余白。
 * 既定より短くはしない（すでに長ければそのまま）。
 */
export function applyRunnerKeepAlive(server: {
  keepAliveTimeout: number;
  headersTimeout: number;
}): void {
  if (server.keepAliveTimeout < RUNNER_KEEP_ALIVE_TIMEOUT_MS) {
    server.keepAliveTimeout = RUNNER_KEEP_ALIVE_TIMEOUT_MS;
  }
  const minHeadersTimeout = server.keepAliveTimeout + 1_000;
  if (server.headersTimeout !== 0 && server.headersTimeout < minHeadersTimeout) {
    server.headersTimeout = minHeadersTimeout;
  }
}
