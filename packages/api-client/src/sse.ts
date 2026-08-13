/**
 * SSE（`text/event-stream`）の読み取り。
 *
 * `EventSource` を使わないのは、あれが GET しか投げられず、ヘッダも付けられない
 * からである。デーモンの chat は `POST /chat` で、本文の無い POST も含めて
 * `content-type: application/json` を要求する（`deliberateClient` の境界）ので、
 * `fetch` の応答本文を自分で解く必要がある。
 *
 * **経路の側を「SSE をやめて GET にする」方向へ単純化しない。** spec や
 * クライアントの都合で API の能力を落とすのは本末転倒である（north_star 禁止1）。
 */

/** SSE の1メッセージ。`event:` が無ければ仕様どおり `message` になる。 */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** `\n\n` / `\r\n\r\n` / `\r\r` のいずれでもメッセージが切れる（SSE の仕様）。 */
const DELIMITER = /\r\n\r\n|\n\n|\r\r/;

/**
 * 応答本文を SSE メッセージの列に変換する。
 *
 * 途中で `break` すると `finally` で本文を解放するので、呼ぶ側は
 * 「必要なところまで読んで抜ける」書き方をしてよい。
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const match = DELIMITER.exec(buffer);
        if (match === null) break;
        const chunk = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = parseSseChunk(chunk);
        if (message !== null) yield message;
      }
    }

    // 最後のメッセージが区切り無しで終わっていても捨てない
    const rest = parseSseChunk(buffer);
    if (rest !== null) yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseSseChunk(chunk: string): SseMessage | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  let seen = false;

  for (const rawLine of chunk.split(/\r\n|\n|\r/)) {
    // コメント行（`:` 始まり。keep-alive に使われる）は捨てる
    if (rawLine.length === 0 || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    // 値の先頭のスペース1つだけを落とす（SSE の仕様）
    const rest = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') {
      event = rest;
      seen = true;
    } else if (field === 'data') {
      data.push(rest);
      seen = true;
    } else if (field === 'id') {
      id = rest;
      seen = true;
    }
  }

  if (!seen) return null;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}
