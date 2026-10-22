import type { ManagerPool } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

// ループの停止の見張りの印だけを差し替えて読む（見張りの本体は使わない）
const phases = vi.hoisted(() => [] as string[]);
vi.mock('@alteroid/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/core')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

const { startManagerPolling } = await import('./manager-poller.js');

// 見回りは印の無いまま 60 秒ごとに段を回していたので、段の中の同期の処理がループを止めても別の出来事の印に見えていた（#4485）
describe('委譲の見回りは段ごとに印を打つ（#4485）', () => {
  it('⭐ 段に入るたびに印を打ち、その段の処理より前に並ぶ。段が投げても次の段へ進み、終わりの印を打つ', async () => {
    phases.length = 0;
    const step = (name: string) => () => {
      phases.push(`run:${name}`);
      return Promise.resolve();
    };
    const managers = {
      sweepRescueRefs: step('rescue-refs'),
      autoFoldUnderPressure: step('auto-fold'),
      probeTurnEnds: () => {
        phases.push('run:turn-ends');
        throw new Error('同期で投げる段');
      },
      flushWithheldReports: () => {
        phases.push('run:withheld-reports');
        return Promise.reject(new Error('非同期で落ちる段'));
      },
      settleStalledUsageWakes: step('usage-wakes'),
      renotifyStalledDenials: step('denials'),
      deliverHeldMessages: step('held-messages'),
    } as unknown as ManagerPool;
    const poller = startManagerPolling({ managers, intervalMs: 60_000 });
    await vi.waitFor(() => expect(phases).toContain('poller:done'));
    poller.stop();

    expect(phases).toEqual([
      'poller:rescue-refs',
      'run:rescue-refs',
      'poller:auto-fold',
      'run:auto-fold',
      'poller:turn-ends',
      'run:turn-ends',
      'poller:withheld-reports',
      'run:withheld-reports',
      'poller:usage-wakes',
      'run:usage-wakes',
      'poller:denials',
      'run:denials',
      'poller:held-messages',
      'run:held-messages',
      'poller:done',
    ]);
  });
});
