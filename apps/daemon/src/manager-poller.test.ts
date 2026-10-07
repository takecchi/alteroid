import type { ManagerPool } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startManagerPolling } from './manager-poller.js';

function fakeManagers(
  run: () => Promise<void> | void,
  flush: () => Promise<void> | void = () => undefined,
  settle: () => Promise<void> | void = () => undefined,
  renotify: () => Promise<void> | void = () => undefined,
): {
  managers: ManagerPool;
  calls: () => number;
  flushCalls: () => number;
  settleCalls: () => number;
  renotifyCalls: () => number;
  order: () => readonly string[];
} {
  let calls = 0;
  let flushCalls = 0;
  let settleCalls = 0;
  let renotifyCalls = 0;
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
    pushHealthOf: () => undefined,
    transcript: () => {
      throw new Error('not implemented');
    },
    unpushedWork: () => {
      throw new Error('not implemented');
    },
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
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
    async settleStalledUsageWakes() {
      settleCalls += 1;
      order.push('settleStalledUsageWakes');
      await settle();
      return [];
    },
    async renotifyStalledDenials() {
      renotifyCalls += 1;
      order.push('renotifyStalledDenials');
      await renotify();
    },
    stop: () => Promise.resolve(),
  };
  return {
    managers,
    calls: () => calls,
    flushCalls: () => flushCalls,
    settleCalls: () => settleCalls,
    renotifyCalls: () => renotifyCalls,
    order: () => order,
  };
}

describe('ターン終了の助言を定期的に取り直す（Issue #567）', () => {
  it('起動直後に1回、待たずに叩く', async () => {
    const { managers, calls } = fakeManagers(() => undefined);
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

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
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    const inFlight = Promise.all([poller.refresh(), poller.refresh(), poller.refresh()]);
    expect(calls()).toBe(1);

    release?.();
    await inFlight;
    expect(calls()).toBe(1);

    poller.stop();
  });

  it('probeTurnEnds が投げても、ポーラー自身は落ちない', async () => {
    const { managers, calls } = fakeManagers(() => {
      throw new Error('生ログが読めなかった（模擬）');
    });
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('止めたら以後取りに行かない', async () => {
    const { managers, calls } = fakeManagers(() => undefined);
    const poller = startManagerPolling({ managers, intervalMs: 5 });
    await poller.refresh();
    poller.stop();

    const after = calls();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls()).toBe(after);
  });

  it('probeTurnEnds() の後ろで flushWithheldReports() も呼ぶ', async () => {
    const { managers, calls, flushCalls, order } = fakeManagers(
      () => undefined,
      () => undefined,
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    expect(calls()).toBeGreaterThanOrEqual(1);
    expect(flushCalls()).toBeGreaterThanOrEqual(1);
    expect(order()).toEqual([
      'probeTurnEnds',
      'flushWithheldReports',
      'settleStalledUsageWakes',
      'renotifyStalledDenials',
    ]);

    poller.stop();
  });

  it('probeTurnEnds() が投げても flushWithheldReports() は走る', async () => {
    const { managers, flushCalls } = fakeManagers(
      () => {
        throw new Error('生ログが読めなかった（模擬）');
      },
      () => undefined,
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

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
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('flushWithheldReports() の後ろで settleStalledUsageWakes() も呼ぶ', async () => {
    const { calls, flushCalls, settleCalls, managers, order } = fakeManagers(
      () => undefined,
      () => undefined,
      () => undefined,
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    expect(calls()).toBeGreaterThanOrEqual(1);
    expect(flushCalls()).toBeGreaterThanOrEqual(1);
    expect(settleCalls()).toBeGreaterThanOrEqual(1);
    expect(order()).toEqual([
      'probeTurnEnds',
      'flushWithheldReports',
      'settleStalledUsageWakes',
      'renotifyStalledDenials',
    ]);

    poller.stop();
  });

  it('flushWithheldReports() が投げても settleStalledUsageWakes() は走る', async () => {
    const { managers, settleCalls } = fakeManagers(
      () => undefined,
      () => {
        throw new Error('配り直せなかった（模擬）');
      },
      () => undefined,
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(settleCalls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('settleStalledUsageWakes() が投げても、ポーラー自身は落ちない', async () => {
    const { managers, calls } = fakeManagers(
      () => undefined,
      () => undefined,
      () => {
        throw new Error('清算に失敗した（模擬）');
      },
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('settleStalledUsageWakes() の後ろで renotifyStalledDenials() も呼ぶ', async () => {
    const { calls, flushCalls, settleCalls, renotifyCalls, managers, order } = fakeManagers(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    expect(calls()).toBeGreaterThanOrEqual(1);
    expect(flushCalls()).toBeGreaterThanOrEqual(1);
    expect(settleCalls()).toBeGreaterThanOrEqual(1);
    expect(renotifyCalls()).toBeGreaterThanOrEqual(1);
    expect(order()).toEqual([
      'probeTurnEnds',
      'flushWithheldReports',
      'settleStalledUsageWakes',
      'renotifyStalledDenials',
    ]);

    poller.stop();
  });

  it('settleStalledUsageWakes() が投げても renotifyStalledDenials() は走る', async () => {
    const { managers, renotifyCalls } = fakeManagers(
      () => undefined,
      () => undefined,
      () => {
        throw new Error('清算に失敗した（模擬）');
      },
      () => undefined,
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(renotifyCalls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });

  it('renotifyStalledDenials() が投げても、ポーラー自身は落ちない', async () => {
    const { managers, calls } = fakeManagers(
      () => undefined,
      () => undefined,
      () => undefined,
      () => {
        throw new Error('知らせ直しに失敗した（模擬）');
      },
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThanOrEqual(1);

    poller.stop();
  });
});
