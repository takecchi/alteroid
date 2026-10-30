import { describe, expect, it } from 'vitest';

import {
  SseSendQueue,
  SSE_SEND_QUEUE_MAX_CHARS,
  SSE_SEND_QUEUE_MAX_ITEMS,
} from './sse-send-queue.js';

// `/chat` 系と `/journal/stream` の購読者1本ぶんの送り待ちを1つの作りにする（#5694）
describe('SseSendQueue', () => {
  it('上限の既定は 5,000 件・16,000,000 字（/chat と /journal/stream で同じ）', () => {
    expect(SSE_SEND_QUEUE_MAX_ITEMS).toBe(5_000);
    expect(SSE_SEND_QUEUE_MAX_CHARS).toBe(16_000_000);
  });

  it('積んだ順に取り出し、書き出す data は積んだときの直列化そのもの', () => {
    const queue = new SseSendQueue<{ n: number }>();
    queue.push({ n: 1 });
    queue.push({ n: 2 });
    expect(queue.shift()).toEqual({ value: { n: 1 }, data: '{"n":1}' });
    expect(queue.shift()?.value.n).toBe(2);
    expect(queue.shift()).toBeUndefined();
    expect(queue.overflow).toBeUndefined();
  });

  it('件数の上限を超えたら、溜めた分を捨てて溢れたことを覚え、以後は積まない', () => {
    const queue = new SseSendQueue<{ n: number }>({ maxItems: 2 });
    queue.push({ n: 1 });
    queue.push({ n: 2 });
    queue.push({ n: 3 });
    expect(queue.overflow).toEqual({ items: 3, chars: 21 });
    expect(queue.shift()).toBeUndefined();
    queue.push({ n: 4 });
    expect(queue.shift()).toBeUndefined();
  });

  it('字数の上限を超えても溢れる。取り出した分は字数から引かれる', () => {
    const queue = new SseSendQueue<{ n: number }>({ maxChars: 14 });
    queue.push({ n: 1 });
    queue.push({ n: 2 });
    queue.shift();
    queue.push({ n: 3 });
    expect(queue.overflow).toBeUndefined();
    queue.push({ n: 4 });
    expect(queue.overflow).toEqual({ items: 3, chars: 21 });
  });

  it('retain で外した分は字数からも外れる', () => {
    const queue = new SseSendQueue<{ n: number }>({ maxChars: 14 });
    queue.push({ n: 1 });
    queue.push({ n: 2 });
    queue.retain((value) => value.n !== 1);
    queue.push({ n: 3 });
    expect(queue.overflow).toBeUndefined();
    expect(queue.shift()?.value.n).toBe(2);
    expect(queue.shift()?.value.n).toBe(3);
  });
});
