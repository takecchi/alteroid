import { describe, expect, it } from 'vitest';

import { parseSSEChunk, readSSE } from './sse-frame.js';

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
    const mid = 30;
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

describe('parseSSEChunk', () => {
  it('コメント行だけの塊は読み飛ばす（デーモンの heartbeat を画面に出さない）', () => {
    expect(parseSSEChunk(': hb')).toBeNull();
    expect(parseSSEChunk('')).toBeNull();
    expect(parseSSEChunk(':')).toBeNull();
  });

  it('コメント行が同じ塊に混ざっても、イベントの中身を壊さない', () => {
    const parsed = parseSSEChunk(': hb\nevent: text\ndata: {"type":"text","text":"やあ"}');

    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('text');
    expect(parsed?.json<{ text: string }>()?.text).toBe('やあ');
  });

  it('ふつうのイベントはこれまでどおり読める（上の2件が緩めでないことの裏取り）', () => {
    const parsed = parseSSEChunk('event: done\ndata: {"type":"done"}');

    expect(parsed?.name).toBe('done');
    expect(parsed?.json<{ type: string }>()?.type).toBe('done');
  });
});
