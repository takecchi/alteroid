import { describe, expect, it } from 'vitest';

import { SseFrameSplitter } from './sse-frames.js';

/** 前の実装（1本の文字列に足して先頭から探す）と同じ答えを出すかを比べる基準。 */
function reference(chunks: readonly string[]): string[] {
  let buffer = '';
  const frames: string[] = [];
  for (const chunk of chunks) {
    buffer += chunk;
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      frames.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  return frames;
}

function split(chunks: readonly string[]): string[] {
  const splitter = new SseFrameSplitter();
  return chunks.flatMap((chunk) => splitter.push(chunk));
}

describe('SseFrameSplitter（#4485）', () => {
  it('1つのかけらの中の複数のフレームを、古い順に返す', () => {
    expect(split(['id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b":2}\n\n'])).toEqual([
      'id: 1\ndata: {"a":1}',
      'id: 2\ndata: {"b":2}',
    ]);
  });

  it('かけらを跨いだ区切り（末尾の \\n と先頭の \\n）を拾う', () => {
    expect(split(['data: x\n', '\ndata: y\n\n'])).toEqual(['data: x', 'data: y']);
  });

  it('大きなフレームが細かく届いても、揃ったときに1つだけ返す', () => {
    const body = 'y'.repeat(200_000);
    const text = `id: 9\ndata: {"body":"${body}"}\n\n`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 4096) chunks.push(text.slice(i, i + 4096));
    expect(split(chunks)).toEqual([`id: 9\ndata: {"body":"${body}"}`]);
  });

  it('どこで切って届いても、前の実装と同じフレームを返す', () => {
    const text = 'id: 1\ndata: a\n\n\n\nid: 2\ndata: b\n\nx\n\n\ndata: c\n\n';
    for (let size = 1; size <= text.length; size += 1) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(split(chunks), `size=${String(size)}`).toEqual(reference(chunks));
    }
  });
});
