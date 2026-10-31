import { describe, expect, it } from 'vitest';

import { InputQueue } from './input-queue.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('InputQueue', () => {
  it('enqueue / dequeue / drain は FIFO', () => {
    const q = new InputQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    expect(q.dequeue()).toBe(1);
    expect(q.drain()).toEqual([2, 3]);
    expect(q.dequeue()).toBeUndefined();
  });

  it('既定では wake が待ち手を全員起こす', async () => {
    const q = new InputQueue<number>();
    const woken: string[] = [];
    const a = q.wait().then(() => woken.push('a'));
    const b = q.wait().then(() => woken.push('b'));
    q.wake();
    await Promise.all([a, b]);
    expect(woken).toEqual(['a', 'b']);
    expect(() => q.wake()).not.toThrow();
  });

  it('singleWaiter では2度目の wait が1本目を上書きする', async () => {
    const q = new InputQueue<number>(true);
    const woken: string[] = [];
    void q.wait().then(() => woken.push('first'));
    const second = q.wait().then(() => woken.push('second'));
    q.wake();
    await second;
    await tick();
    expect(woken).toEqual(['second']);
  });

  it('iterator は積まれた分を読み切り、待ち、close で終わる', async () => {
    const q = new InputQueue<number>();
    q.enqueue(1);
    const seen: number[] = [];
    const done = (async () => {
      for await (const item of q) seen.push(item);
    })();
    await tick();
    expect(seen).toEqual([1]);
    q.enqueue(2);
    q.wake();
    await tick();
    expect(seen).toEqual([1, 2]);
    q.enqueue(3);
    q.close();
    await done;
    expect(seen).toEqual([1, 2, 3]);
  });
});
