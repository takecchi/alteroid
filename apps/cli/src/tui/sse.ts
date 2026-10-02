/**
 * SSE の本文を 1 フレームずつ読む。フレームの解釈（`event:` / `data:` と、heartbeat の
 * コメント行を読み飛ばすこと）は既存 CLI の `parseSSEChunk`（`../chat.ts`）をそのまま使う。
 * `chat.ts` 内の `readSSE` は export されていない（他の担当と衝突しないよう chat.ts は
 * 触らない）ので、フレームを切る薄い読み手だけをここに置く。
 */
import { parseSSEChunk, type SSEEvent } from '../chat.js';

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSSEChunk(chunk);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // 読み手が途中で抜けても本文の読み取りを確実に閉じる。
    await reader.cancel().catch(() => undefined);
  }
}
