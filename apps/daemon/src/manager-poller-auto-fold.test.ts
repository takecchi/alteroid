import type { ManagerPool } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startManagerPolling } from './manager-poller.js';

function poolWith(
  autoFold: (() => Promise<void>) | undefined,
  probeTurnEnds: () => Promise<never[]> = async () => [],
): ManagerPool {
  return {
    probeTurnEnds,
    flushWithheldReports: async () => undefined,
    settleStalledUsageWakes: async () => [],
    renotifyStalledDenials: async () => undefined,
    ...(autoFold === undefined ? {} : { autoFoldUnderPressure: autoFold }),
    stop: () => Promise.resolve(),
  } as unknown as ManagerPool;
}

describe('ManagerPoller と周回の自動の畳み（#5157）', () => {
  it('1周ごとに autoFoldUnderPressure を呼ぶ。投げても refresh は終わる', async () => {
    let calls = 0;
    const poller = startManagerPolling({
      managers: poolWith(async () => {
        calls += 1;
        throw new Error('模擬');
      }),
      intervalMs: 3_600_000,
    });
    await poller.refresh();
    expect(calls).toBeGreaterThanOrEqual(1);
    poller.stop();
  });

  it('連鎖に繋がない: auto-fold が終わらなくても他の段の1周（refresh）は待たされない', async () => {
    let turnEndsCalled = false;
    const poller = startManagerPolling({
      managers: poolWith(
        () => new Promise<void>(() => undefined),
        async () => {
          turnEndsCalled = true;
          return [];
        },
      ),
      intervalMs: 3_600_000,
    });
    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(turnEndsCalled).toBe(true);
    poller.stop();
  });

  it('他の段が終わらなくても、auto-fold は呼ばれる（他の段の完了を待たない）', async () => {
    let called = false;
    const poller = startManagerPolling({
      managers: poolWith(
        async () => {
          called = true;
        },
        () => new Promise<never[]>(() => undefined),
      ),
      intervalMs: 3_600_000,
    });
    void poller.refresh();
    // 実時間で待たない（#2146）: 段は refresh の頭で呼ばれるので、呼ばれたことだけを待つ
    await expect.poll(() => called).toBe(true);
    poller.stop();
  });

  it('口を持たない実装でも回る', async () => {
    const poller = startManagerPolling({ managers: poolWith(undefined), intervalMs: 3_600_000 });
    await expect(poller.refresh()).resolves.toBeUndefined();
    poller.stop();
  });
});
