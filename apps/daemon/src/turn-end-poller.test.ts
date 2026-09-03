import type { ManagerPool } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startTurnEndPolling } from './turn-end-poller.js';

/**
 * `ManagerPool` の全メソッドを実装するが、このポーラーが呼ぶのは
 * `probeTurnEnds()` / `flushWithheldReports()` だけ——それ以外は呼ばれない
 * 前提で投げる（`usage-poller.test.ts` と同じ足場の作法）。
 */
function fakeManagers(
  run: () => Promise<void> | void,
  flush: () => Promise<void> | void = () => undefined,
): {
  managers: ManagerPool;
  calls: () => number;
  flushCalls: () => number;
  /** どちらが先に呼ばれたか記録する（順序を固定する試験用）。 */
  order: () => readonly string[];
} {
  let calls = 0;
  let flushCalls = 0;
  const order: string[] = [];
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
    runnerIdOf: () => Promise.resolve(undefined),
    runners: () => {
      throw new Error('not implemented');
    },
    transcript: () => {
      throw new Error('not implemented');
    },
    restore: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: () => {
      throw new Error('not implemented');
    },
    vacate: () => {
      throw new Error('not implemented');
    },
    async probeTurnEnds() {
      calls += 1;
      order.push('probeTurnEnds');
      await run();
    },
    async flushWithheldReports() {
      flushCalls += 1;
      order.push('flushWithheldReports');
      await flush();
    },
    stop: () => Promise.resolve(),
  };
  return { managers, calls: () => calls, flushCalls: () => flushCalls, order: () => order };
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

  /**
   * `flushWithheldReports()`（握り潰した「背景処理の完了待ちで畳んだ報告」を
   * 時間で必ず配る逃げ道）が、この周期に相乗りすることを固定する
   * （`turn-end-poller.ts` の doc）。
   */
  it('probeTurnEnds() の後ろで flushWithheldReports() も呼ぶ', async () => {
    const { managers, calls, flushCalls, order } = fakeManagers(
      () => undefined,
      () => undefined,
    );
    const poller = startTurnEndPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    expect(calls()).toBeGreaterThanOrEqual(1);
    expect(flushCalls()).toBeGreaterThanOrEqual(1);
    // **順序そのものが要点**（`probeTurnEnds` の中に入れていないこと）。
    expect(order()).toEqual(['probeTurnEnds', 'flushWithheldReports']);

    poller.stop();
  });

  it('probeTurnEnds() が投げても flushWithheldReports() は走る', async () => {
    const { managers, flushCalls } = fakeManagers(
      () => {
        throw new Error('生ログが読めなかった（模擬）');
      },
      () => undefined,
    );
    const poller = startTurnEndPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(flushCalls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('flushWithheldReports() が投げても、ポーラー自身は落ちない', async () => {
    const { managers, calls } = fakeManagers(
      () => undefined,
      () => {
        throw new Error('配り直せなかった（模擬）');
      },
    );
    const poller = startTurnEndPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });
});
