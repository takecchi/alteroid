import type { UsageStore } from './store.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageTotals } from './usage.js';

/**
 * `UsageStore` の「runner ごとの最後の累積」の約束（Issue #3022 仮説1）を、**実装1つに対して**
 * 測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - 現役の runner の累積（`runner.superseded: false`）は、基準の高さへ畳み、runner ごとの控えも更新する
 * - 古い runner（`superseded: true`）の累積は、**基準の高さへ畳まず**、その runner 自身の前回との差だけを積む
 *   （記録済みの分を二重に数えない・増えた分は取りこぼさない）
 * - 控えが無い runner・累積が減っていた runner は積まず、`skipped` で理由を返す
 * - runner を名乗らない `record` は控えを消さない。基準の行が無い manager への古い runner の累積は、基準を作らない
 *
 * 呼ぶ前の台帳は空でなくてもよい（`managerId` は他と衝突しない値を使う）。vitest に依存しない。
 */
export async function verifyUsageRunnerContract(usage: UsageStore): Promise<void> {
  function fail(message: string, detail?: unknown): never {
    throw new Error(
      `UsageStore の runner の契約違反: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
  const managerId = 'mgr-runner-contract';
  const date = '2026-10-06';
  let tick = 0;
  const at = (): string => `2026-10-06T00:00:${String(10 + tick++).padStart(2, '0')}.000Z`;
  const models = (costUsd: number): Record<string, UsageTotals> => ({
    opus: { ...ZERO_USAGE, inputTokens: costUsd * 100, costUsd },
  });
  const record = (
    cost: number,
    runner?: { id: string; superseded: boolean },
    id: string = managerId,
  ) =>
    usage.record({
      layer: 'manager',
      site: 'session',
      managerId: id,
      date,
      at: at(),
      snapshot: { sessionId: 'sess', models: models(cost) },
      accumulation: 'cumulative',
      ...(runner === undefined ? {} : { runner }),
    });
  const total = async (id: string = managerId): Promise<number> => {
    const { rows } = await usage.aggregate({ managerId: id });
    return rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
  };
  const expectTotal = async (expected: number, label: string, id?: string): Promise<void> => {
    const actual = await total(id);
    if (Math.abs(actual - expected) > 1e-9)
      fail(`${label}: 合計が ${String(expected)} でない`, actual);
  };

  await record(10, { id: 'runner-a', superseded: false });
  await record(1, { id: 'runner-b', superseded: false });
  await expectTotal(11, '現役の runner が切り替わった（数え直し）');

  const same = await record(10, { id: 'runner-a', superseded: true });
  if (same.skipped !== undefined || Object.keys(same.delta).length !== 0) {
    fail('古い runner の同じ累積が増分になった（二重計上）', same);
  }
  await expectTotal(11, '古い runner の再送');

  const more = await record(12, { id: 'runner-a', superseded: true });
  if (more.delta['opus']?.costUsd !== 2)
    fail('古い runner の増えた分（2）が増分でない', more.delta);
  await expectTotal(13, '古い runner の増えた分');
  const baseline = await usage.baseline('manager', managerId);
  if (baseline?.models['opus']?.costUsd !== 1) fail('古い runner が基準の高さを動かした', baseline);
  if (baseline.byRunner?.['runner-a']?.['opus']?.costUsd !== 12) {
    fail('runner ごとの控えが更新されていない', baseline.byRunner);
  }

  const decreased = await record(4, { id: 'runner-a', superseded: true });
  if (decreased.skipped?.reason !== 'decreased' || Object.keys(decreased.delta).length !== 0) {
    fail('減った累積を積んだ／理由が返らない', decreased);
  }
  await expectTotal(13, '減った累積');

  const unknown = await record(7, { id: 'runner-c', superseded: true });
  if (unknown.skipped?.reason !== 'unknown-runner' || Object.keys(unknown.delta).length !== 0) {
    fail('控えの無い runner の累積を積んだ／理由が返らない', unknown);
  }
  await expectTotal(13, '控えの無い runner');

  await record(2, undefined);
  const kept = await usage.baseline('manager', managerId);
  if (kept?.byRunner?.['runner-a']?.['opus']?.costUsd !== 4) {
    fail('runner を名乗らない record が控えを消した', kept?.byRunner);
  }
  await expectTotal(14, 'runner を名乗らない record');

  const orphan = await record(5, { id: 'runner-a', superseded: true }, 'mgr-runner-contract-none');
  if (orphan.skipped?.reason !== 'unknown-runner')
    fail('基準の無い manager の理由が返らない', orphan);
  if ((await usage.baseline('manager', 'mgr-runner-contract-none')) !== null) {
    fail('古い runner の累積が基準の行を作った');
  }
  await expectTotal(0, '基準の無い manager', 'mgr-runner-contract-none');
}
