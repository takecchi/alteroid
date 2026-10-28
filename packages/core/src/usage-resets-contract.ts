import type { UsageStore } from './store.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageLayer, UsageResetRow, UsageTotals } from './usage.js';

// 3実装（インメモリ / fs / pg）が `aggregate().resets` を同じ形で返すことを測る（Issue #5409）
// 同じ店に他の記録が在っても通るように、自分が書いた managerId の行だけを見る
export async function verifyUsageResetsContract(usage: UsageStore): Promise<void> {
  function fail(message: string, detail?: unknown): never {
    throw new Error(
      `UsageStore の resets の契約違反: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
  const date = '2026-10-07';
  let tick = 0;
  const at = (): string => `2026-10-07T00:00:${String(10 + tick++).padStart(2, '0')}.000Z`;
  const models = (costUsd: number): Record<string, UsageTotals> => ({
    opus: { ...ZERO_USAGE, inputTokens: costUsd * 100, costUsd },
  });
  const record = async (layer: UsageLayer, managerId: string, cost: number): Promise<string> => {
    const when = at();
    await usage.record({
      layer,
      site: 'session',
      managerId,
      date,
      at: when,
      snapshot: { sessionId: 'sess', models: models(cost) },
      accumulation: 'cumulative',
    });
    return when;
  };
  const mine = new Set(['mgr-resets-a', 'mgr-resets-b', 'mgr-resets-clone']);
  const pick = (rows: readonly UsageResetRow[] | undefined): UsageResetRow[] =>
    (rows ?? []).filter((row) => mine.has(row.managerId));

  // a: 数え直しが2回（10 → 3 → 1）、b: 1度も無い、clone 層: 1回（5 → 2）
  await record('manager', 'mgr-resets-a', 10);
  await record('manager', 'mgr-resets-a', 3);
  const lastA = await record('manager', 'mgr-resets-a', 1);
  await record('manager', 'mgr-resets-b', 5);
  await record('manager', 'mgr-resets-b', 7);
  await record('clone', 'mgr-resets-clone', 5);
  const lastClone = await record('clone', 'mgr-resets-clone', 2);

  const expected: UsageResetRow[] = [
    { layer: 'clone', managerId: 'mgr-resets-clone', resets: 1, lastResetAt: lastClone },
    { layer: 'manager', managerId: 'mgr-resets-a', resets: 2, lastResetAt: lastA },
    { layer: 'manager', managerId: 'mgr-resets-b', resets: 0 },
  ];
  const all = pick((await usage.aggregate({})).resets);
  if (JSON.stringify(all) !== JSON.stringify(expected)) {
    fail('回数・最終時刻・並び（層、managerId の順）が違う（無い基準は 0 回・最終時刻なし）', all);
  }

  const onlyA = (await usage.aggregate({ managerId: 'mgr-resets-a' })).resets;
  if (JSON.stringify(onlyA) !== JSON.stringify([expected[1]])) {
    fail('managerId で絞れていない', onlyA);
  }
  const onlyClone = pick((await usage.aggregate({ layer: 'clone' })).resets);
  if (JSON.stringify(onlyClone) !== JSON.stringify([expected[0]])) {
    fail('layer で絞れていない', onlyClone);
  }

  // 基準は日付を持たない現在値: 日付で絞っても落とさない
  const later = pick((await usage.aggregate({ from: '2099-01-01' })).resets);
  if (JSON.stringify(later) !== JSON.stringify(expected)) {
    fail('日付の絞り込みで resets が変わった（日付に依らない現在値のはず）', later);
  }
  const earlier = pick((await usage.aggregate({ to: '2000-01-01' })).resets);
  if (JSON.stringify(earlier) !== JSON.stringify(expected)) {
    fail('日付の絞り込み（to）で resets が変わった', earlier);
  }

  // 該当する基準が無い絞り込みは欄ごと無い（空配列を返さない）
  const none = await usage.aggregate({ managerId: 'mgr-resets-none' });
  if (none.resets !== undefined) fail('基準が無いのに resets が載った', none.resets);
}
