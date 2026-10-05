import { ZERO_USAGE } from './usage-format.js';
import type { UsageStore } from './store.js';

/**
 * `UsageStore` の鍵列の NUL の約束（issue #2927。teto の判断、2026-10-05）を、**実装1つに対して**
 * 測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * **消費の台帳は、鍵（`managerId`・`model`・`tokenId`・`provider`）の NUL も断らず、落として残す。**
 * 外から来る鍵でも、記録そのものを失わない種類の台帳では落として残す（断ると消費が台帳から消える）。
 *
 * - `record`: 鍵列の NUL を落とした行として積まれる。例外は投げない
 * - `aggregate`: 絞り込み（`managerId`・`tokenId`）は NUL を落としてから引く。投げず、一致なしは空の集計（issue #3005）
 * - `baseline` / `recordedManagerIds`: NUL を落とした managerId で引ける（NUL つきで引いても同じ）
 * - `recordUnmetered`: 例外を投げない
 *
 * 呼ぶ前の台帳は空であること。台帳に記録が残る（`clear()` で消す）。vitest に依存しない。
 */
export async function verifyUsageNulContract(usage: UsageStore): Promise<void> {
  function fail(message: string, detail?: unknown): never {
    throw new Error(
      `UsageStore の NUL の契約違反: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }

  const fold = await usage.record({
    layer: 'manager',
    site: 'session',
    managerId: 'mgr-\u0000nul',
    date: '2026-10-05',
    at: '2026-10-05T00:00:00.000Z',
    snapshot: {
      sessionId: 'ses-\u0000x',
      models: { 'mo\u0000del': { ...ZERO_USAGE, inputTokens: 3, costUsd: 0.5 } },
    },
    accumulation: 'cumulative',
    tokenId: 'tok-\u0000id',
  });
  if (fold.delta['model'] === undefined) fail('増分のモデル名から NUL が落ちていない', fold.delta);

  const aggregate = await usage.aggregate({});
  const row = aggregate.rows[0];
  if (
    aggregate.rows.length !== 1 ||
    row?.managerId !== 'mgr-nul' ||
    row.model !== 'model' ||
    row.tokenId !== 'tok-id'
  ) {
    fail('鍵列の NUL を落とした行として積まれていない', aggregate.rows);
  }

  for (const managerId of ['mgr-nul', 'mgr-\u0000nul']) {
    const baseline = await usage.baseline('manager', managerId);
    if (baseline === null || baseline.managerId !== 'mgr-nul' || baseline.sessionId !== 'ses-x') {
      fail(`基準が NUL を落とした鍵で引けない（${JSON.stringify(managerId)}）`, baseline);
    }
  }
  if (!(await usage.recordedManagerIds()).has('mgr-nul')) {
    fail('recordedManagerIds に NUL を落とした managerId が無い');
  }

  await usage.recordUnmetered({
    layer: 'clone',
    site: 'session',
    managerId: 'cl-\u0000one',
    date: '2026-10-05',
    at: '2026-10-05T00:00:00.000Z',
    provider: 'prov-\u0000x',
    tokenId: 'tok-\u0000id',
  });

  // aggregate() の絞り込み（issue #3005）: 書き込みで落として残したのと対称に、落としてから引く。
  // NUL つきで引いても、落とした値で引いても同じ行が出る。投げない。
  for (const query of [
    { managerId: 'mgr-nul' },
    { managerId: 'mgr-\u0000nul' },
    { tokenId: 'tok-\u0000id' },
    { managerId: 'mgr-\u0000nul', tokenId: 'tok-\u0000id' },
  ]) {
    const filtered = await usage.aggregate(query);
    if (
      filtered.rows.length !== 1 ||
      filtered.rows[0]?.managerId !== 'mgr-nul' ||
      filtered.turnRows.length !== 1
    ) {
      fail(
        `aggregate の絞り込みが NUL を落として引いていない（${JSON.stringify(query)}）`,
        filtered,
      );
    }
  }
  const filteredClone = await usage.aggregate({ managerId: 'cl-\u0000one' });
  if (
    filteredClone.unmeteredRows?.length !== 1 ||
    filteredClone.unmeteredRows[0]?.managerId !== 'cl-one'
  ) {
    fail('aggregate の絞り込み（無報告の行）が NUL を落として引いていない', filteredClone);
  }
  // 書いていない値で引けば一致なし（NUL を落とした結果が空文字でも投げない）。
  const none = await usage.aggregate({ managerId: 'no-such\u0000mgr' });
  if (
    none.rows.length !== 0 ||
    none.turnRows.length !== 0 ||
    (none.unmeteredRows?.length ?? 0) !== 0
  ) {
    fail('一致しない絞り込みが行を返した', none);
  }

  await usage.clear();
}
