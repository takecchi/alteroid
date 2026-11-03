import { describe, expect, it } from 'vitest';

import { parseSseJson, readSse } from './sse.js';

// `apps/cli/src/sse-frame.test.ts`（cli 独自の SSE パーサの試験）から移した。cli は `readSse`（api-client の実装）を使うようになったので、
// cli が頼っていた性質が同じ実装で保たれていることを、ここで同じ入力・同じ期待で確かめる。
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
  for await (const event of readSse(body)) out.push({ name: event.event, data: event.data });
  return out;
}

describe('readSse（cli が頼る性質）', () => {
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
    const bytes = new TextEncoder().encode('event: text\ndata: {"text":"日本語"}\n\n');
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

  it('コメント行だけの塊（`:` だけの行を含む）は何も出さない', async () => {
    expect(await collect(bodyOf([': hb\n\n:\n\n']))).toEqual([]);
  });

  it('コメント行が同じ塊に混ざっても、イベントの中身を壊さない', async () => {
    const events = await collect(
      bodyOf([': hb\nevent: text\ndata: {"type":"text","text":"やあ"}\n\n']),
    );
    expect(events).toEqual([{ name: 'text', data: '{"type":"text","text":"やあ"}' }]);
    expect(parseSseJson<{ text: string }>(events[0] ?? { data: '' })?.text).toBe('やあ');
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
    for await (const event of readSse(body)) {
      expect(event.event).toBe('a');
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe('parseSseJson', () => {
  it('JSON として読めればその値、読めなければ null（投げない）', () => {
    expect(parseSseJson<{ type: string }>({ data: '{"type":"done"}' })?.type).toBe('done');
    expect(parseSseJson({ data: '' })).toBeNull();
    expect(parseSseJson({ data: '{壊れた' })).toBeNull();
  });
});
