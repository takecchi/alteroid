import { afterEach, describe, expect, it, vi } from 'vitest';

import { FORCED_EXIT_MS, shutdownThenExit } from './index.js';

function install(): ReturnType<typeof vi.spyOn> {
  vi.useFakeTimers();
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shutdownThenExit: 停止の途中で投げても exit に届く（#5949）', () => {
  it('handOver が投げても exit(0) を呼び、投げたエラーはそのまま返る', async () => {
    const exit = install();
    const afterHandOver = vi.fn();
    await expect(
      shutdownThenExit({
        forcedExitMs: FORCED_EXIT_MS,
        handOver: () => Promise.reject(new Error('boom')),
        afterHandOver,
      }),
    ).rejects.toThrow('boom');
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(afterHandOver).not.toHaveBeenCalled();
  });

  it('ふだんの停止は handOver → afterHandOver → exit(0)', async () => {
    const exit = install();
    const order: string[] = [];
    exit.mockImplementation((() => {
      order.push('exit');
    }) as never);
    await shutdownThenExit({
      forcedExitMs: FORCED_EXIT_MS,
      handOver: async () => {
        order.push('handOver');
      },
      afterHandOver: () => {
        order.push('afterHandOver');
      },
    });
    expect(order).toEqual(['handOver', 'afterHandOver', 'exit']);
  });

  it('handOver が返らなくても、先頭で張った時計が FORCED_EXIT_MS で exit(0) を呼ぶ', async () => {
    const exit = install();
    void shutdownThenExit({
      forcedExitMs: FORCED_EXIT_MS,
      handOver: () => new Promise<void>(() => undefined),
      afterHandOver: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(FORCED_EXIT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
