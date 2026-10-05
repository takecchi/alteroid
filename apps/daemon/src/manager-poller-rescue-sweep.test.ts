import type { ManagerPool } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startManagerPolling } from './manager-poller.js';

/** ポーラーが退避 ref の後始末（`sweepRescueRefs`。Issue #1266）を回し、その失敗で落ちないこと。 */
function poolWith(sweep: (() => Promise<void>) | undefined): ManagerPool {
  return {
    probeTurnEnds: async () => [],
    flushWithheldReports: async () => undefined,
    settleStalledUsageWakes: async () => [],
    renotifyStalledDenials: async () => undefined,
    ...(sweep === undefined ? {} : { sweepRescueRefs: sweep }),
    stop: () => Promise.resolve(),
  } as unknown as ManagerPool;
}

describe('ManagerPoller と退避 ref の後始末（#1266）', () => {
  it('1周ごとに sweepRescueRefs を呼ぶ。投げても refresh は終わる', async () => {
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

  it('sweep が終わらなくても、他の関心事の1周（refresh）は待たされない', async () => {
    const poller = startManagerPolling({
      managers: poolWith(() => new Promise<void>(() => undefined)),
      intervalMs: 3_600_000,
    });
    const outcome = await Promise.race([
      poller.refresh().then(() => 'refreshed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1500)),
    ]);
    expect(outcome).toBe('refreshed');
    poller.stop();
  });

  it('口を持たない実装でも回る', async () => {
    const poller = startManagerPolling({ managers: poolWith(undefined), intervalMs: 3_600_000 });
    await expect(poller.refresh()).resolves.toBeUndefined();
    poller.stop();
  });
});
