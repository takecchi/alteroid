import { setStderrSinkForTesting, type ManagerPool } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startManagerPolling } from './manager-poller.js';

// 見回りの段の構造を固定する試験（pin）。段を表（配列）にして回す整理の前に置く。
// ⚠️ 期待値は仕様を先に書いたものではなく、整理前の `manager-poller.ts` の出力を読んで確かめたもの。
// 縛るのは段の数・順・連鎖に繋ぐか・失敗の握り方（stderr の文言と間引き）・間隔であり、表の長さや型ではない。
const STAGES = [
  { label: 'rescue-refs', method: 'sweepRescueRefs', chained: false },
  { label: 'auto-fold', method: 'autoFoldUnderPressure', chained: false },
  { label: 'turn-ends', method: 'probeTurnEnds', chained: true },
  { label: 'withheld-reports', method: 'flushWithheldReports', chained: true },
  { label: 'usage-wakes', method: 'settleStalledUsageWakes', chained: true },
  { label: 'denials', method: 'renotifyStalledDenials', chained: true },
  { label: 'silence', method: 'noteSilentManagers', chained: true },
  { label: 'held-messages', method: 'deliverHeldMessages', chained: true },
  { label: 'task-follow', method: 'repairStrandedTasks', chained: true },
] as const;

const ALL_METHODS: readonly string[] = STAGES.map((stage) => stage.method);

type Behavior = () => unknown;

// 実際に呼ばれるメソッド名を、呼ばれた順に記録する。段の集合は「表の長さ」ではなく、ここに残る名前で固定する。
function recordingPool(behaviors: Readonly<Record<string, Behavior>> = {}) {
  const calls: string[] = [];
  const pool: Record<string, unknown> = {};
  for (const method of ALL_METHODS) {
    pool[method] = () => {
      calls.push(method);
      return behaviors[method]?.() ?? Promise.resolve();
    };
  }
  return { managers: pool as unknown as ManagerPool, calls };
}

describe('見回りの段の構造（表にする整理の前の固定）', () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    setStderrSinkForTesting((line) => {
      lines.push(line);
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    setStderrSinkForTesting(null);
  });

  it('呼ばれる段の集合と順序: 9 段だけが、この順で1回ずつ呼ばれる', async () => {
    const { managers, calls } = recordingPool();
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });
    await poller.refresh();
    poller.stop();

    expect(calls).toEqual([
      'sweepRescueRefs',
      'autoFoldUnderPressure',
      'probeTurnEnds',
      'flushWithheldReports',
      'settleStalledUsageWakes',
      'renotifyStalledDenials',
      'noteSilentManagers',
      'deliverHeldMessages',
      'repairStrandedTasks',
    ]);
    expect(lines).toEqual([]);
  });

  it('await の並び: 起動の同期の区間で、連鎖に繋がない 2 段と連鎖の先頭だけが呼ばれる', () => {
    const { managers, calls } = recordingPool({
      probeTurnEnds: () => new Promise(() => undefined),
    });
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });
    // 1 つも await していない: 連鎖の 2 段目以降は、前の段が終わるまで呼ばれない
    expect(calls).toEqual(['sweepRescueRefs', 'autoFoldUnderPressure', 'probeTurnEnds']);
    poller.stop();
  });

  describe.each(STAGES.filter((stage) => stage.chained).map((stage, i) => ({ ...stage, i })))(
    '連鎖の段 $label',
    ({ method, i }) => {
      it('終わるまで次の段を始めない。終わったら次へ進む', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { managers, calls } = recordingPool({ [method]: () => gate });
        const poller = startManagerPolling({ managers, intervalMs: 10_000 });
        const inFlight = poller.refresh();
        await vi.advanceTimersByTimeAsync(0);

        const chained = STAGES.filter((stage) => stage.chained).map((stage) => stage.method);
        expect(calls).toEqual([
          'sweepRescueRefs',
          'autoFoldUnderPressure',
          ...chained.slice(0, i + 1),
        ]);

        release();
        await inFlight;
        poller.stop();
        expect(calls).toEqual(ALL_METHODS);
      });
    },
  );

  describe.each(STAGES)('段 $label が落ちても', ({ label, method }) => {
    for (const mode of ['同期で投げる', '拒否で落ちる'] as const) {
      it(`${mode}: 他の 8 段は同じ順で走り、stderr に段の名前と理由を 1 行残す`, async () => {
        const failure: Behavior =
          mode === '同期で投げる'
            ? () => {
                throw new Error(`${label}の失敗（模擬）`);
              }
            : () => Promise.reject(new Error(`${label}の失敗（模擬）`));
        const { managers, calls } = recordingPool({ [method]: failure });
        const poller = startManagerPolling({ managers, intervalMs: 10_000 });
        await expect(poller.refresh()).resolves.toBeUndefined();
        poller.stop();

        expect(calls).toEqual(ALL_METHODS);
        expect(lines).toEqual([
          `alteroidd: 見回りの段 ${label} が失敗しました（次の回も続けます）: Error: ${label}の失敗（模擬）\n`,
        ]);
      });
    }
  });

  it('失敗の間引きは段ごと: 全段が同じ理由で落ちても 9 段それぞれ 1 行、2 周目は書かない。成功で戻ればまた書く', async () => {
    let failing = true;
    const behaviors: Record<string, Behavior> = {};
    for (const method of ALL_METHODS) {
      behaviors[method] = () => {
        if (failing) throw new Error('同じ理由（模擬）');
        return undefined;
      };
    }
    const { managers } = recordingPool(behaviors);
    const poller = startManagerPolling({ managers, intervalMs: 10_000 });

    await poller.refresh();
    expect(lines).toHaveLength(9);
    for (const { label } of STAGES) {
      expect(lines.filter((line) => line.includes(`見回りの段 ${label} `))).toHaveLength(1);
    }

    await poller.refresh();
    expect(lines).toHaveLength(9);

    failing = false;
    await poller.refresh();
    failing = true;
    await poller.refresh();
    poller.stop();
    expect(lines).toHaveLength(18);
  });

  describe('間隔（60 秒ごと）', () => {
    it('既定は 60 秒: 59,999 ミリ秒では次の周回を始めず、60,000 で始める', async () => {
      const { managers, calls } = recordingPool();
      const poller = startManagerPolling({ managers });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter((name) => name === 'probeTurnEnds')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(calls.filter((name) => name === 'probeTurnEnds')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.filter((name) => name === 'probeTurnEnds')).toHaveLength(2);
      poller.stop();
    });

    it('intervalMs を渡せばその間隔で、周回ごとに 9 段すべてを呼ぶ', async () => {
      const { managers, calls } = recordingPool();
      const poller = startManagerPolling({ managers, intervalMs: 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(ALL_METHODS);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toHaveLength(9);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([...ALL_METHODS, ...ALL_METHODS]);
      poller.stop();
    });
  });
});
