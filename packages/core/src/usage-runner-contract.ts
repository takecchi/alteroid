import type { UsageStore } from './store.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageTotals } from './usage.js';

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
  // 基準の高さ（1）が動いていないことは、あとの「runner を名乗らない record」の増分（2 - 1）が合計 14 になることで測る。
  // runner-a の控えが 12 に更新されたことは、11 が「減った」と断られることで測る（控えが 10 のままなら 1 が積まれる）。

  const decreased = await record(11, { id: 'runner-a', superseded: true });
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
  await expectTotal(14, 'runner を名乗らない record');
  const kept = await record(12, { id: 'runner-a', superseded: true });
  if (kept.skipped !== undefined || kept.delta['opus']?.costUsd !== 1) {
    fail('runner を名乗らない record が控えを消した（11 との差 1 が積まれない）', kept);
  }
  await expectTotal(15, '控えを残した古い runner の増えた分');

  const orphan = await record(5, { id: 'runner-a', superseded: true }, 'mgr-runner-contract-none');
  if (orphan.skipped?.reason !== 'unknown-runner')
    fail('基準の無い manager の理由が返らない', orphan);
  await expectTotal(0, '基準の無い manager', 'mgr-runner-contract-none');
  // 基準の行が作られていたら、最初の通常の record が全量（5）ではなく差で積まれてしまう
  const first = await record(5, undefined, 'mgr-runner-contract-none');
  if (first.delta['opus']?.costUsd !== 5) {
    fail('古い runner の累積が基準の行を作った', first);
  }
}
