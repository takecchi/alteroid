/**
 * SSE のコメント行 heartbeat（無音死の掃除）。
 *
 * ## なぜコメント行か
 *
 * 新しいイベント名は作らない。`event: heartbeat` にすると `data:` が空でも
 * SSE の1メッセージとして成立してしまい、クライアント側で `JSON.parse('')` を
 * 踏みうる（実際 `packages/api-client/src/index.ts` の `stream()` は
 * `data === '' ? undefined : JSON.parse(...)` と書いてあるので踏まないが、
 * 別のクライアントがそこまで丁寧とは限らない）。SSE の仕様上、`:` で始まる行
 * （コメント行）はクライアントが**フィールドとして解釈せず捨てる**。既存の3実装
 * （`apps/cli/src/chat.ts` の `parseSSEChunk`、`packages/api-client/src/sse.ts` の
 * `parseSseChunk`、それを使う `packages/api-client/src/index.ts` の `stream()`）
 * は3つとも「フィールド行が1つも無いチャンクは message として yield しない」
 * 形になっており、コメント行だけのチャンクは黙って読み飛ばされる。
 *
 * ## なぜ1回の `write()` で書き切るか
 *
 * `SSEStreamingApi#write`（`hono/utils/stream.js` の `StreamingApi#write`）は
 * 引数の文字列を丸ごと1回だけ `this.writer.write(input)`（`TransformStream` の
 * writer）に渡す。WHATWG Streams はこの1呼び出しの引数を**1個の chunk**として
 * 扱い、chunk の内部でバイト単位に分割して他の chunk と混ぜることはない
 * （`hono/helper/streaming/sse.js` の `writeSSE` も同様に、`sseData` を組み立てて
 * から `this.write(sseData)` を1回呼ぶだけ）。だから heartbeat が `write()` を
 * 1回で終える限り、進行中の `writeSSE()` の chunk の**中に割り込んでバイトが
 * 混ざることはない**——起こりうるのは chunk の**前後関係の入れ替わり**だけで、
 * これは SSE クライアントにとって普通のことである。
 *
 * ## write() は死んだ接続へ書いても「表向きは」何も起こさない
 *
 * `StreamingApi#write` は `this.writer.write(input)` を `try { } catch {}` で
 * 包んでいる（`hono/utils/stream.js`）。**失敗しても例外を投げず、`aborted` /
 * `closed` のどちらも自分では立てない。** heartbeat がこの `write()` の戻り値
 * だけを見て「掃除された」と判断することはできない。
 *
 * それでも掃除は起きる——ただし別の経路からである。`@hono/node-server`
 * （`dist/index.mjs` の `writeFromReadableStreamDefaultReader`）は Node の
 * `http.ServerResponse`（`outgoing`）に `close` / `error` リスナーを張ってあり、
 * 発火すると内部の `reader.cancel(error)` を呼ぶ。この `reader` は
 * `SSEStreamingApi#responseReadable` の reader で、その `cancel` コールバック
 * （`hono/utils/stream.js` の `StreamingApi` コンストラクタ）が `this.abort()` を
 * 呼び、`aborted = true` を立てて `abortSubscribers`（＝各経路が
 * `stream.onAbort(...)` で登録したコールバック）を同期的に全部呼ぶ。
 *
 * つまり **`aborted` / `closed` が立つのは、書き込みが原因で Node 側の
 * `outgoing` が `close` / `error` を出したときであって、heartbeat 自身が
 * それを直接検知するわけではない。** 死んだ接続に何も書かなければ、TCP は
 * 何も再送しようとせず、OS が異常に気づく機会そのものが無いまま fd が残り
 * 続ける（これが今回塞ぎたい無音死そのもの）。heartbeat の役目は、この
 * 「気づく機会」を周期的に作ることである——書いたデータが相手に届かなければ
 * いずれ TCP の再送が尽きて `outgoing` が `error` を出し、上の経路を通って
 * `onAbort` が発火し、既存の `finally { unsubscribe() }` が動く。既定では
 * これに数分〜十数分かかる（OS の再送タイムアウト依存）。TCP keepalive を
 * 別途入れるならこの経路を代替するのではなく、**アイドル中でも OS が
 * 相手の生死を確かめにいく**という別の検知経路を足す形になる。
 *
 * ## なぜ `packages/core` に在るか
 *
 * SSE を**出す側**は2つある —— デーモンが CLI/Web へ出す経路（`apps/daemon` の
 * `POST /chat` と `GET /journal/stream`）と、runner がデーモンへ出す経路
 * （`apps/runner` の `GET /events`）である。**どちらか一方の `apps/*` に置くと、
 * もう一方がそれを読むために逆向きの依存を作ることになる** —— とくに
 * `apps/runner` は `apps/daemon` を知らない設計で、そこは意図して引いてある線
 * である（`apps/runner/src/app.ts` 冒頭「叩くのはデーモンだけである」）。
 * 両方が既に依存している `@alteroid/core` へ置けば、線を跨がずに1つの実装を
 * 共有できる。
 *
 * **そのぶん、この層は `hono` を知らない。** `@alteroid/core` の依存に `hono` は
 * 無く、足すつもりも無い（core は transport を持たない層である）。だから引数は
 * {@link SseHeartbeatStream} という**構造的な型**で受ける —— hono の
 * `SSEStreamingApi` はこの形を満たすので、呼ぶ側は何も包まずにそのまま渡せる。
 *
 * ## 念のための自衛
 *
 * 上の経路が何らかの理由で `aborted` / `closed` を立てても `onAbort` の
 * 発火に繋がらない場合に備え、heartbeat の tick 自体でもこの2つを見て、
 * 立っていればタイマーを止めて `wake` を呼ぶ（すでに `finished` / `closed`
 * 相当の状態なら空振りしても安全 — 呼び出し側の `wake` は `null` なら
 * 何もしない形で使われている）。**これは主経路の代替ではなく二重化である。**
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

/**
 * SSE のコメント行。**改行は `\n\n` で終える** —— コメント行の後ろに空行が
 * 無いと、直後にバッファされている次のフィールド行と1メッセージに混ざって
 * 解釈されうる（SSE はメッセージの区切りを空行で決める）。
 */
export const HEARTBEAT_FRAME = ': hb\n\n';

/**
 * heartbeat が要求する SSE ストリームの形。**hono の型を import しない。**
 *
 * これは hono の `SSEStreamingApi` を狭めたもの（かつては
 * `Pick<SSEStreamingApi, 'aborted' | 'closed' | 'write'>` と書いてあった）で、
 * **同じ3つを、hono を知らずに言い直しただけである。** 実体は変わらないので
 * 呼ぶ側は `streamSSE(c, async (stream) => …)` の `stream` をそのまま渡せる。
 *
 * `write` の戻りを `Promise<unknown>` にしてあるのは、hono の `write` が返す
 * `StreamingApi` を core が名指ししないためである（heartbeat はこの戻り値を
 * 使わない —— 使えないことの理由は冒頭の JSDoc「write() は死んだ接続へ書いても
 * 「表向きは」何も起こさない」）。
 */
export interface SseHeartbeatStream {
  readonly aborted: boolean;
  readonly closed: boolean;
  write(input: string): Promise<unknown>;
}

/**
 * SSE 経路に heartbeat を仕込む。
 *
 * 呼ぶ側は返ってきた stop 関数を**必ず `finally` で呼ぶこと**——呼ばないと、
 * ストリームが終わった後もタイマーが残る（`write()` 自体は死んだ相手に書いても
 * 例外を出さないので、残っていても壊れて見えないぶん気づきにくい）。
 *
 * `wake` は「ブロックしているメインループを起こす」ためのコールバックで、
 * 既存の `stream.onAbort(...)` が行っているのと同じ役目を heartbeat 側からも
 * 呼べるようにするための二重化である（このモジュールの JSDoc の「念のための
 * 自衛」を参照）。
 */
export function startSseHeartbeat(
  stream: SseHeartbeatStream,
  intervalMs: number,
  wake: () => void,
): () => void {
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) {
      clearInterval(timer);
      wake();
      return;
    }
    /*
     * **`void` だけで済ませない。`catch` を付ける。**
     *
     * いまの `StreamingApi#write` は中で `try { } catch {}` しているので拒否した
     * Promise を返さない（このモジュール冒頭の JSDoc）。だが**それに依存すると、
     * 依存先が変わった日に落ち方が「デーモンの死」になる** —— Node 15 以降の
     * 既定は `--unhandled-rejections=throw` で、拾われない拒否はプロセスを
     * 終了させる。heartbeat は全 SSE 接続で回るタイマーなので、ここが投げると
     * 1本の死んだ接続がデーモン全体を落とす。
     *
     * **握り潰してよい理由は「ここが検知の主経路ではない」からである。** 書けな
     * かったことに意味を持たせているのは Node 側の `outgoing` の `close` /
     * `error` → `reader.cancel()` → `abort()` の経路（冒頭の JSDoc）で、この
     * `catch` はその経路を塞がない。次の tick で `aborted` / `closed` を見る
     * 自衛も残る。
     */
    void stream.write(HEARTBEAT_FRAME).catch(() => {});
  }, intervalMs);
  /*
   * **`unref()` する。** heartbeat は「接続が在るあいだ回る」ものであって、
   * プロセスを生かしておく理由ではない。接続そのものは `http.Server` の
   * ハンドルが生かしているので、ここを ref したままにしても得るものが無く、
   * 逆に停止時（`SHUTDOWN_GRACE_MS` 待ち）や、ループが `wake` を待ったまま
   * 戻らない経路で、event loop を空にできない理由をひとつ増やすだけである。
   */
  timer.unref?.();
  return () => clearInterval(timer);
}
