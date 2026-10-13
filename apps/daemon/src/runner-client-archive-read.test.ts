import { describe, expect, it } from 'vitest';

import { readTextYielding } from './runner-client.js';

function responseOf(chunks: readonly Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe('readTextYielding: 退避の本文を塊ごとに文字へ戻し、途中でループへ順番を返す（#4485）', () => {
  it('UTF-8 の文字が塊の境目で割れても、response.text() と同じ文字列になる', async () => {
    const bytes = new TextEncoder().encode('{"text":"日本語の報告"}\n'.repeat(3));
    // 「日」の3バイトの途中で割る
    const cut = bytes.indexOf(0xe6) + 1;
    const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];

    expect(await readTextYielding(responseOf(chunks), 1)).toBe(await responseOf(chunks).text());
  });

  it('本文が無ければ空文字', async () => {
    expect(await readTextYielding(new Response(null), 1024)).toBe('');
  });

  it('決めた量を読むたびに順番を返す（読み終える前に setImmediate の仕事が回る）', async () => {
    const chunks = Array.from({ length: 8 }, () => new Uint8Array(1024).fill(0x61));
    let ranBeforeDone = false;
    let done = false;
    setImmediate(() => {
      if (!done) ranBeforeDone = true;
    });

    const text = await readTextYielding(responseOf(chunks), 2048);
    done = true;

    expect(text).toBe('a'.repeat(8 * 1024));
    expect(ranBeforeDone).toBe(true);
  });
});
