import { describe, expect, it } from 'vitest';

import { readSSE } from './sse.js';

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
): Promise<{ name: string; data: string }[]> {
  const out: { name: string; data: string }[] = [];
  for await (const event of readSSE(body)) out.push({ name: event.name, data: event.data });
  return out;
}

describe('readSSE', () => {
  it('フレームを event / data に分ける', async () => {
    const events = await collect(
      bodyOf([
        'event: open\ndata: {"conversationId":"c1"}\n\nevent: text\ndata: {"text":"やあ"}\n\n',
      ]),
    );
    expect(events).toEqual([
      { name: 'open', data: '{"conversationId":"c1"}' },
      { name: 'text', data: '{"text":"やあ"}' },
    ]);
  });

  it('チャンクの切れ目がフレームの途中・マルチバイト文字の途中でも読める', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('event: text\ndata: {"text":"日本語"}\n\n');
    const mid = 30; // 「日本語」の途中のバイト
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    expect(await collect(body)).toEqual([{ name: 'text', data: '{"text":"日本語"}' }]);
  });

  it('heartbeat のコメント行だけのフレームは読み飛ばす', async () => {
    const events = await collect(bodyOf([': ping\n\nevent: done\ndata: {"type":"done"}\n\n']));
    expect(events.map((e) => e.name)).toEqual(['done']);
  });

  it('読み手が途中で抜けたら本文の読み取りを閉じる', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readSSE(body)) {
      expect(event.name).toBe('a');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
