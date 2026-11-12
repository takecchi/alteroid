import { fakeManagerPool, setStderrSinkForTesting, type ManagerPool } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startManagerPolling } from './manager-poller.js';

function fakeManagers(
  run: () => Promise<void> | void,
  flush: () => Promise<void> | void = () => undefined,
  settle: () => Promise<void> | void = () => undefined,
  renotify: () => Promise<void> | void = () => undefined,
  silence: () => Promise<void> | void = () => undefined,
): {
  managers: ManagerPool;
  calls: () => number;
  flushCalls: () => number;
  settleCalls: () => number;
  renotifyCalls: () => number;
  silenceCalls: () => number;
  order: () => readonly string[];
} {
  let calls = 0;
  let flushCalls = 0;
  let settleCalls = 0;
  let renotifyCalls = 0;
  let silenceCalls = 0;
  const order: string[] = [];
  const managers: ManagerPool = fakeManagerPool({
    list: () => {
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
    async noteSilentManagers() {
      silenceCalls += 1;
      order.push('noteSilentManagers');
      await silence();
    },
  });
  return {
    managers,
    calls: () => calls,
    flushCalls: () => flushCalls,
    settleCalls: () => settleCalls,
    renotifyCalls: () => renotifyCalls,
    silenceCalls: () => silenceCalls,
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
      'noteSilentManagers',
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
      'noteSilentManagers',
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
      'noteSilentManagers',
    ]);

    poller.stop();
  });

  it('renotifyStalledDenials() の後ろで noteSilentManagers() も呼ぶ。前の段が投げても走り、自身が投げてもポーラーは落ちない', async () => {
    const ok = fakeManagers(() => undefined);
    const okPoller = startManagerPolling({ managers: ok.managers, intervalMs: 10_000 });
    await okPoller.refresh();
    okPoller.stop();
    expect(ok.silenceCalls()).toBe(1);
    expect(ok.order().slice(-2)).toEqual(['renotifyStalledDenials', 'noteSilentManagers']);

    const prior = fakeManagers(
      () => undefined,
      () => undefined,
      () => undefined,
      () => {
        throw new Error('知らせ直しに失敗した（模擬）');
      },
    );
    const priorPoller = startManagerPolling({ managers: prior.managers, intervalMs: 10_000 });
    await priorPoller.refresh();
    priorPoller.stop();
    expect(prior.silenceCalls()).toBe(1);

    const own = fakeManagers(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => {
        throw new Error('無音の見張りに失敗した（模擬）');
      },
    );
    const ownPoller = startManagerPolling({ managers: own.managers, intervalMs: 10_000 });
    await expect(ownPoller.refresh()).resolves.toBeUndefined();
    ownPoller.stop();
    expect(own.calls()).toBeGreaterThanOrEqual(1);
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

// 新しい仕様を先に書いた試験（8 段目 task-follow）: 報告由来の done で waiting のままの task を、猶予を過ぎたら倒す見回り。60 秒ごと・冪等。
describe('8 段目 task-follow: repairStrandedTasks() を見回りごとに呼ぶ', () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    setStderrSinkForTesting((line) => {
      lines.push(line);
    });
  });
  afterEach(() => {
    setStderrSinkForTesting(null);
  });

  function managersWithRepair(repair: () => Promise<void> | void) {
    const order: string[] = [];
    const managers: ManagerPool = fakeManagerPool({
      async probeTurnEnds() {
        order.push('probeTurnEnds');
      },
      async flushWithheldReports() {
        order.push('flushWithheldReports');
      },
      async settleStalledUsageWakes() {
        order.push('settleStalledUsageWakes');
        return [];
      },
      async renotifyStalledDenials() {
        order.push('renotifyStalledDenials');
      },
      async deliverHeldMessages() {
        order.push('deliverHeldMessages');
      },
      async repairStrandedTasks() {
        order.push('repairStrandedTasks');
        await repair();
      },
    });
    return { managers, order };
  }

  it('見回りの 1 回ごとに 1 回呼ぶ（既定の間隔は 60 秒の見回りそのもの）', async () => {
    const { managers, order } = managersWithRepair(() => undefined);
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    poller.stop();

    expect(order.filter((name) => name === 'repairStrandedTasks')).toHaveLength(1);
  });

  it('失敗（同期・非同期）は段の名前と理由を stderr に残し、ポーラー自身は落ちない', async () => {
    const { managers, order } = managersWithRepair(() =>
      Promise.reject(new Error('task ストアが落ちている（模擬）')),
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await expect(poller.refresh()).resolves.toBeUndefined();
    poller.stop();

    expect(order).toContain('repairStrandedTasks');
    const failed = lines.filter((line) => line.includes('task-follow'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('task ストアが落ちている（模擬）');
  });

  it('前の段（held-messages）が投げても、8 段目は走る', async () => {
    const order: string[] = [];
    const managers: ManagerPool = fakeManagerPool({
      async deliverHeldMessages() {
        throw new Error('預かり分が配れない（模擬）');
      },
      async repairStrandedTasks() {
        order.push('repairStrandedTasks');
      },
    });
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    poller.stop();

    expect(order).toEqual(['repairStrandedTasks']);
  });
});

describe('見回りの段の失敗は stderr に跡を残す（止めない・間引く）', () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    setStderrSinkForTesting((line) => {
      lines.push(line);
    });
  });
  afterEach(() => {
    setStderrSinkForTesting(null);
  });

  const failuresOf = (label: string) => lines.filter((line) => line.includes(label));

  it('段が投げる（同期）と、段の名前と理由を stderr に1行残し、後ろの段は走る', async () => {
    const { managers, flushCalls } = fakeManagers(() => {
      throw new Error('生ログが読めなかった（模擬）');
    });
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    poller.stop();

    expect(failuresOf('turn-ends')).toHaveLength(1);
    expect(failuresOf('turn-ends')[0]).toContain('生ログが読めなかった（模擬）');
    expect(flushCalls()).toBeGreaterThanOrEqual(1);
  });

  it('段が拒否で落ちる（非同期）ときも、stderr に跡を残す', async () => {
    const { managers } = fakeManagers(
      () => undefined,
      () => Promise.reject(new Error('預かった伝言を渡せない（模擬）')),
    );
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    poller.stop();

    expect(failuresOf('withheld-reports')).toHaveLength(1);
    expect(failuresOf('withheld-reports')[0]).toContain('預かった伝言を渡せない（模擬）');
  });

  it('同じ失敗が続く間は2回目から書かない。成功で戻り、また落ちたら書く', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const { managers } = fakeManagers(() => {
      if (mode === 'fail') throw new Error('同じ失敗（模擬）');
    });
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    await poller.refresh();
    await poller.refresh();
    expect(failuresOf('turn-ends')).toHaveLength(1);

    mode = 'ok';
    await poller.refresh();
    mode = 'fail';
    await poller.refresh();
    poller.stop();

    expect(failuresOf('turn-ends')).toHaveLength(2);
  });

  it('理由が変われば同じ段でも書く', async () => {
    let n = 0;
    const { managers } = fakeManagers(() => {
      n += 1;
      throw new Error(`失敗${n}（模擬）`);
    });
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    await poller.refresh();
    poller.stop();

    expect(failuresOf('turn-ends')).toHaveLength(2);
  });
});
