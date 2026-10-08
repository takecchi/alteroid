import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_SSE_HEARTBEAT_MS, startSseHeartbeat } from './sse-heartbeat.js';

function fakeStream() {
  const writes: string[] = [];
  const stream = {
    aborted: false,
    closed: false,
    write(input: string) {
      writes.push(input);
      return Promise.resolve(stream as never);
    },
  };
  return { stream, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('間隔ごとに1回だけ書く（周期そのものを見る）', () => {
  const { stream, writes } = fakeStream();
  const stop = startSseHeartbeat(stream, 1000, () => undefined);

  expect(writes).toEqual([]);

  vi.advanceTimersByTime(999);
  expect(writes).toEqual([]);

  vi.advanceTimersByTime(1);
  expect(writes).toHaveLength(1);

  vi.advanceTimersByTime(3000);
  expect(writes).toHaveLength(4);

  stop();
});

it('1回の write() で、コメント行1本ぶんを空行まで書き切る', () => {
  const { stream, writes } = fakeStream();
  const stop = startSseHeartbeat(stream, 1000, () => undefined);

  vi.advanceTimersByTime(1000);

  expect(writes).toHaveLength(1);
  const frame = writes[0] ?? '';
  expect(frame.startsWith(':')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  expect(frame).not.toContain('data:');
  expect(frame).not.toContain('event:');

  stop();
});

it('stop でタイマーが消える（ストリームが終わった後に書き続けない）', () => {
  const { stream, writes } = fakeStream();
  const stop = startSseHeartbeat(stream, 1000, () => undefined);

  vi.advanceTimersByTime(1000);
  expect(writes).toHaveLength(1);

  stop();

  vi.advanceTimersByTime(10_000);
  expect(writes).toHaveLength(1);
});

it('aborted が立っていたら書かずに止まり、待っているループを起こす', () => {
  const { stream, writes } = fakeStream();
  let woke = 0;
  const stop = startSseHeartbeat(stream, 1000, () => (woke += 1));

  stream.aborted = true;
  vi.advanceTimersByTime(1000);

  expect(writes).toEqual([]);
  expect(woke).toBe(1);

  vi.advanceTimersByTime(10_000);
  expect(woke).toBe(1);
  expect(writes).toEqual([]);

  stop();
});

it('closed が立っていたら書かずに止まり、待っているループを起こす', () => {
  const { stream, writes } = fakeStream();
  let woke = 0;
  const stop = startSseHeartbeat(stream, 1000, () => (woke += 1));

  stream.closed = true;
  vi.advanceTimersByTime(1000);

  expect(writes).toEqual([]);
  expect(woke).toBe(1);

  vi.advanceTimersByTime(10_000);
  expect(woke).toBe(1);

  stop();
});

it('write() が拒否しても、拾われない拒否を作らず次の刻みも回る', async () => {
  const writes: string[] = [];
  const stream = {
    aborted: false,
    closed: false,
    write(input: string) {
      writes.push(input);
      return Promise.reject(new Error('相手はもう居ない')) as never;
    },
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const stop = startSseHeartbeat(stream, 1000, () => undefined);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    stop();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  expect(writes).toHaveLength(2);
  expect(unhandled).toEqual([]);
});

it('既定間隔は、よくある無通信切断（30秒）の窓に2回入る', () => {
  expect(DEFAULT_SSE_HEARTBEAT_MS * 2).toBeLessThanOrEqual(30_000);
  expect(DEFAULT_SSE_HEARTBEAT_MS).toBeGreaterThanOrEqual(5_000);
});

it('onBeat は1拍ごとに1回呼ばれ、接続が死んだ拍では呼ばれない（issue #1820）', () => {
  const { stream } = fakeStream();
  let beats = 0;
  let woken = 0;
  const stop = startSseHeartbeat(
    stream,
    1000,
    () => {
      woken += 1;
    },
    () => {
      beats += 1;
    },
  );

  vi.advanceTimersByTime(3000);
  expect(beats).toBe(3);
  expect(woken).toBe(0);

  stream.closed = true;
  vi.advanceTimersByTime(1000);
  expect(beats).toBe(3);
  expect(woken).toBe(1);

  stop();
});
