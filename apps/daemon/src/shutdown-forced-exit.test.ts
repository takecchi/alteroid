import { afterEach, describe, expect, it, vi } from 'vitest';

import { DAEMON_FORCED_EXIT_MS } from '@alteroid/core';

import { shutdownThenExit } from './index.js';

const FAREWELL_WINDOW_MS = 52_000;
const never = (): Promise<void> => new Promise<void>(() => undefined);

function install(): ReturnType<typeof vi.spyOn> {
  vi.useFakeTimers();
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shutdownThenExit: 強制 exit は SIGTERM から FORCED_EXIT_MS で落ちる（#5949）', () => {
  it('drain が返らなくても、FORCED_EXIT_MS で exit(0) を呼ぶ（手前では呼ばない）', async () => {
    const exit = install();
    const stopClone = vi.fn(async () => undefined);
    void shutdownThenExit({
      forcedExitMs: DAEMON_FORCED_EXIT_MS,
      farewellWindowMs: FAREWELL_WINDOW_MS,
      drain: never,
      stopClone,
      closeStorage: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(DAEMON_FORCED_EXIT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(stopClone).not.toHaveBeenCalled();
  });

  it('時計は drain の前に張る: drain の途中でまだ何も終わっていない時点で、すでに張られている', () => {
    install();
    let armedAtDrain = -1;
    void shutdownThenExit({
      forcedExitMs: DAEMON_FORCED_EXIT_MS,
      farewellWindowMs: FAREWELL_WINDOW_MS,
      drain: () => {
        armedAtDrain = vi.getTimerCount();
        return never();
      },
      stopClone: async () => undefined,
      closeStorage: async () => undefined,
    });
    expect(armedAtDrain).toBe(1);
  });

  it('ふだんの停止は順序どおり drain → stopClone → closeStorage → exit(0)。締切は入った瞬間から窓のぶん', async () => {
    const exit = install();
    vi.setSystemTime(1_000_000);
    const order: string[] = [];
    exit.mockImplementation((() => {
      order.push('exit');
    }) as never);
    let deadline = 0;
    await shutdownThenExit({
      forcedExitMs: DAEMON_FORCED_EXIT_MS,
      farewellWindowMs: FAREWELL_WINDOW_MS,
      drain: async () => {
        order.push('drain');
      },
      stopClone: async (at) => {
        deadline = at;
        order.push('stopClone');
      },
      closeStorage: async () => {
        order.push('closeStorage');
      },
    });
    expect(order).toEqual(['drain', 'stopClone', 'closeStorage', 'exit']);
    expect(deadline).toBe(1_000_000 + FAREWELL_WINDOW_MS);
  });

  it('stopClone が投げても closeStorage と exit(0) へ進む', async () => {
    const exit = install();
    const closeStorage = vi.fn(async () => undefined);
    await shutdownThenExit({
      forcedExitMs: DAEMON_FORCED_EXIT_MS,
      farewellWindowMs: FAREWELL_WINDOW_MS,
      drain: async () => undefined,
      stopClone: () => Promise.reject(new Error('boom')),
      closeStorage,
    });
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
