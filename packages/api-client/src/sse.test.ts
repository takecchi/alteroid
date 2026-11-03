import { expect, it } from 'vitest';

import { readJsonSse, readSse } from './sse.js';

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

// 境界: 途中で切れた行・複数行の data（cli の SSE パーサを統合したので、cli が頼る入力も含めて固定する）。
it('行の途中で切れても1つの行として読む（event 名・data の値の途中）', async () => {
  const messages = await collect(bodyOf('ev', 'ent: te', 'xt\nda', 'ta: {"a"', ':1}\n', '\n'));
  expect(messages).toEqual([{ event: 'text', data: '{"a":1}' }]);
});

it('区切りの空行の途中（\\n と \\n の間・\\r と \\n の間）で切れても1つの区切りとして読む', async () => {
  expect(await collect(bodyOf('event: a\ndata: 1\n', '\nevent: b\ndata: 2\n\n'))).toEqual([
    { event: 'a', data: '1' },
    { event: 'b', data: '2' },
  ]);
  expect(
    await collect(bodyOf('event: a\r\ndata: 1\r', '\n\r', '\nevent: b\r\ndata: 2\r\n\r\n')),
  ).toEqual([
    { event: 'a', data: '1' },
    { event: 'b', data: '2' },
  ]);
});

it('複数行の data は、チャンクが各行の途中で切れても改行で繋ぐ（空行の data も1行として数える）', async () => {
  expect(await collect(bodyOf('data: a\nda', 'ta: b\ndata:\n', 'data: c\n\n'))).toEqual([
    { event: 'message', data: 'a\nb\n\nc' },
  ]);
});

it('data の値は先頭の空白1つだけを落とす（それ以上の先頭の空白・末尾の空白は残す）', async () => {
  expect(await collect(bodyOf('data:x\n\n', 'data: x\n\n', 'data:  x \n\n'))).toEqual([
    { event: 'message', data: 'x' },
    { event: 'message', data: 'x' },
    { event: 'message', data: ' x ' },
  ]);
});

it('data 行の無いフレーム（event だけ）も出す。コメント・未知のフィールドだけのフレームは出さない', async () => {
  expect(await collect(bodyOf('event: done\n\n', ': ping\n\n', 'retry: 100\n\n'))).toEqual([
    { event: 'done', data: '' },
  ]);
});

it('区切りの後に残った断片（終端の空行が無い）は、流れが閉じたときに出す', async () => {
  expect(await collect(bodyOf('event: a\ndata: 1\n\nevent: b\nda', 'ta: 2'))).toEqual([
    { event: 'a', data: '1' },
    { event: 'b', data: '2' },
  ]);
});

it('readJsonSse — data を JSON として読む。data が空なら undefined（id は運ばない）', async () => {
  const out = [];
  for await (const message of readJsonSse(
    bodyOf('event: open\ndata: {"conversationId":"c-1"}\nid: 3\n\n', 'event: done\n\n'),
  )) {
    out.push(message);
  }
  expect(out).toEqual([
    { event: 'open', data: { conversationId: 'c-1' } },
    { event: 'done', data: undefined },
  ]);
});

it('readJsonSse — JSON として読めない data は投げる（黙って捨てない）', async () => {
  await expect(readJsonSse(bodyOf('event: text\ndata: {壊れた\n\n')).next()).rejects.toThrow(
    SyntaxError,
  );
});
