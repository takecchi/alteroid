import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #2745 の歯。日報のターンが枠切れ（`heldForUsage`）以外の理由で失敗すると、
 * 「作れなかった」の印を1行書いて終わり、デーモンを再起動するまで作り直されなかった
 * （後追い `missingDailyReportDates` は起動時に1回だけ走る）。
 *
 * 失敗した回は、一定の間を置いて自分で作り直す。**回数は有限**（恒常的な失敗で
 * 回り続けない）。印は消さず、使い切ったあとも残る。
 */

const DATE = '2026-10-04';

type Row = { type: 'daily_report'; date: string; body: string; unavailable?: string };

function setupWithRetry(
  failTurns: (turnIndex: number) => boolean,
  retryDelaysMs: number[],
): {
  clone: ReturnType<typeof createClone>;
  stores: ReturnType<typeof createMemoryStores>;
  calls: { inputs: string[] }[];
} {
  const stores = createMemoryStores();
  const { fn, calls } = fakeSdk(() => '今日はログイン周りを直した。', {
    resultFor: (turnIndex) =>
      failTurns(turnIndex)
        ? { subtype: 'error_during_execution', text: 'API の一時的な過負荷' }
        : undefined,
  });
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    dailyReportRetryDelaysMs: retryDelaysMs,
  } as Parameters<typeof createClone>[0]);
  return { clone, stores, calls };
}

const reportsOf = async (stores: ReturnType<typeof createMemoryStores>) =>
  (await stores.journal.list({ types: ['daily_report'] })) as Row[];

const post = (clone: ReturnType<typeof createClone>): void =>
  clone.post({
    type: 'timer',
    id: `evt-timer-${DATE}`,
    at: new Date().toISOString(),
    kind: 'daily_report',
    target: DATE,
  } as never);

describe('クローン — 日報が枠切れ以外で失敗した回の作り直し（#2745）', () => {
  it('1回目が失敗しても、再起動なしで後から本物の日報が書かれる（印は残る）', async () => {
    const s = setupWithRetry((turn) => turn === 0, [20]);
    post(s.clone);

    await waitFor(
      async () => (await reportsOf(s.stores)).some((r) => r.unavailable === undefined),
      '作り直しで本物の日報が書かれる',
    );
    const rows = await reportsOf(s.stores);
    expect(rows.filter((r) => r.unavailable !== undefined)).toHaveLength(1);
    expect(rows.filter((r) => r.unavailable === undefined)).toHaveLength(1);
    await s.clone.stop();
  });

  it('失敗し続けるなら、有限回で止まる（印は1件のまま）', async () => {
    const s = setupWithRetry(() => true, [10, 10]);
    post(s.clone);

    await waitFor(() => turnsOf(s.calls) >= 3, '初回＋2回の作り直しが走る');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(turnsOf(s.calls)).toBe(3);
    const rows = await reportsOf(s.stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unavailable).toBeDefined();
    await s.clone.stop();
  });
});

const turnsOf = (calls: { inputs: string[] }[]): number =>
  calls.reduce((sum, call) => sum + call.inputs.length, 0);
