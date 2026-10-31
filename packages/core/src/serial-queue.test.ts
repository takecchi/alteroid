import { describe, expect, it } from 'vitest';
import { createSerialQueue } from './serial-queue.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSerialQueue', () => {
  it('同時に呼んでも、1本ずつ呼んだ順に走る', async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const gate = deferred();
    const first = queue.run(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 1;
    });
    const second = queue.run(async () => {
      events.push('second:start');
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('前が失敗しても後は走り、失敗は呼んだ本人にだけ返る', async () => {
    const queue = createSerialQueue();
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const following = queue.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    await expect(queue.run(async () => 'later')).resolves.toBe('later');
  });

  it('同期で投げる処理でも列が止まらない', async () => {
    const queue = createSerialQueue();
    const failing = queue.run(() => {
      throw new Error('sync boom');
    });
    const following = queue.run(async () => 'ok');
    await expect(failing).rejects.toThrow('sync boom');
    await expect(following).resolves.toBe('ok');
  });

  it('idle は積まれた処理が（失敗を含めて）終わるまで待つ', async () => {
    const queue = createSerialQueue();
    const gate = deferred();
    let done = false;
    const failing = queue.run(async () => {
      await gate.promise;
      done = true;
      throw new Error('boom');
    });
    failing.catch(() => undefined);
    const idle = queue.idle().then(() => done);
    gate.resolve();
    await expect(idle).resolves.toBe(true);
  });

  it('別の列は互いを待たない', async () => {
    const a = createSerialQueue();
    const b = createSerialQueue();
    const gate = deferred();
    const blocked = a.run(() => gate.promise);
    await expect(b.run(async () => 'b')).resolves.toBe('b');
    gate.resolve();
    await blocked;
  });
});
