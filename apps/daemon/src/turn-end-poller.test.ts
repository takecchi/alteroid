import type { ManagerPool } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startTurnEndPolling } from './turn-end-poller.js';

/**
 * `ManagerPool` の全メソッドを実装するが、このポーラーが呼ぶのは
 * `probeTurnEnds()` だけ——それ以外は呼ばれない前提で投げる
 * （`usage-poller.test.ts` と同じ足場の作法）。
 */
function fakeManagers(run: () => Promise<void> | void): {
  managers: ManagerPool;
  calls: () => number;
} {
  let calls = 0;
  const managers: ManagerPool = {
    start: () => {
      throw new Error('not implemented');
    },
    send: () => {
      throw new Error('not implemented');
    },
    abort: () => {
      throw new Error('not implemented');
    },
    list: () => {
      throw new Error('not implemented');
    },
    denials: () => [],
    runnerBacklog: () => [],
    runners: () => {
      throw new Error('not implemented');
    },
    transcript: () => {
      throw new Error('not implemented');
    },
    restore: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    async probeTurnEnds() {
      calls += 1;
      await run();
    },
    stop: () => Promise.resolve(),
  };
  return { managers, calls: () => calls };
}

describe('ターン終了の助言を定期的に取り直す（Issue #567）', () => {
  it('起動直後に1回、待たずに叩く', async () => {
    const { managers, calls } = fakeManagers(() => undefined);
    const poller = startTurnEndPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('前の回が終わる前に次を始めない（重ねない）', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { managers, calls } = fakeManagers(() => gate);
    const poller = startTurnEndPolling({ managers, intervalMs: 10_000 });

    // 起動直後の1回がまだ `gate` で止まっている間に、追加で3本 refresh を重ねる。
    const inFlight = Promise.all([poller.refresh(), poller.refresh(), poller.refresh()]);
    expect(calls()).toBe(1); // 重ねていないので、まだ1回しか呼ばれていない。

    release?.();
    await inFlight;
    expect(calls()).toBe(1); // 解放後も、待っていた3本は同じ1回に合流しただけ。

    poller.stop();
  });

  it('probeTurnEnds が投げても、ポーラー自身は落ちない', async () => {
    const { managers, calls } = fakeManagers(() => {
      throw new Error('生ログが読めなかった（模擬）');
    });
    const poller = startTurnEndPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('止めたら以後取りに行かない', async () => {
    const { managers, calls } = fakeManagers(() => undefined);
    const poller = startTurnEndPolling({ managers, intervalMs: 5 });
    await poller.refresh();
    poller.stop();

    const after = calls();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls()).toBe(after);
  });
});
