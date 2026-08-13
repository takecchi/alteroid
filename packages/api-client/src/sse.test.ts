import { expect, it } from 'vitest';

import { readSse } from './sse.js';

function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const message of readSse(body)) out.push(message);
  return out;
}

it('event / data / id を取り出す', async () => {
  const messages = await collect(
    bodyOf('event: text\ndata: {"type":"text"}\n\n', 'event: done\ndata: {"type":"done"}\n\n'),
  );
  expect(messages).toEqual([
    { event: 'text', data: '{"type":"text"}' },
    { event: 'done', data: '{"type":"done"}' },
  ]);
});

it('チャンクの切れ目がメッセージの途中でも落とさない', async () => {
  const messages = await collect(bodyOf('event: te', 'xt\ndata: {"a":', '1}\n\nevent: done\n\n'));
  expect(messages).toEqual([
    { event: 'text', data: '{"a":1}' },
    { event: 'done', data: '' },
  ]);
});

it('複数行の data は改行で繋ぐ。コメント行（keep-alive）は捨てる', async () => {
  const messages = await collect(bodyOf(': ping\n\nevent: x\ndata: a\ndata: b\nid: 7\n\n'));
  expect(messages).toEqual([{ event: 'x', data: 'a\nb', id: '7' }]);
});

it('event が無ければ message（SSE の既定）', async () => {
  expect(await collect(bodyOf('data: hello\n\n'))).toEqual([{ event: 'message', data: 'hello' }]);
});

it('区切り無しで終わった最後のメッセージも捨てない', async () => {
  expect(await collect(bodyOf('event: done\ndata: {}'))).toEqual([{ event: 'done', data: '{}' }]);
});

it('CRLF でも切れる', async () => {
  expect(await collect(bodyOf('event: a\r\ndata: 1\r\n\r\n'))).toEqual([{ event: 'a', data: '1' }]);
});
