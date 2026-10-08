import { USAGE_NUL_ONLY_TOKEN_ID } from './usage-input.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageStore } from './store.js';

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
  const none = await usage.aggregate({ managerId: 'no-such\u0000mgr' });
  if (
    none.rows.length !== 0 ||
    none.turnRows.length !== 0 ||
    (none.unmeteredRows?.length ?? 0) !== 0
  ) {
    fail('一致しない絞り込みが行を返した', none);
  }

  for (const range of [
    { from: '2026-10-0\u00005' },
    { to: '2026-10-0\u00005' },
    { from: '2026-10-05', to: '2026-10-0\u00005' },
    { from: '\u0000' },
  ]) {
    let ranged;
    try {
      ranged = await usage.aggregate(range);
    } catch (error) {
      fail(
        `aggregate(NULを含む日付)は投げない（${error instanceof Error ? error.name : typeof error}）`,
      );
    }
    if (
      ranged.rows.length !== 0 ||
      ranged.turnRows.length !== 0 ||
      (ranged.unmeteredRows?.length ?? 0) !== 0
    ) {
      fail(`NULを含む日付の範囲は一致なし（${JSON.stringify(range)}）`, ranged);
    }
  }
  if ((await usage.aggregate({ from: '2026-10-05', to: '2026-10-05' })).rows.length !== 1) {
    fail('NULを含む日付で引いたら台帳が変わった');
  }

  await usage.clear();
  const nulOnlyInput = {
    layer: 'manager' as const,
    site: 'session' as const,
    date: '2026-10-05',
    at: '2026-10-05T00:00:00.000Z',
    accumulation: 'cumulative' as const,
  };
  await usage.record({
    ...nulOnlyInput,
    managerId: 'mgr-a',
    snapshot: { sessionId: 's-a', models: { m: { ...ZERO_USAGE, inputTokens: 1 } } },
    tokenId: '\u0000\u0000',
  });
  await usage.record({
    ...nulOnlyInput,
    managerId: 'mgr-b',
    snapshot: { sessionId: 's-b', models: { m: { ...ZERO_USAGE, inputTokens: 2 } } },
  });
  await usage.recordUnmetered({
    layer: 'clone',
    site: 'session',
    managerId: 'cl-a',
    date: '2026-10-05',
    at: '2026-10-05T00:00:00.000Z',
    provider: 'prov',
    tokenId: '\u0000',
  });
  const all = await usage.aggregate({});
  const marked = all.rows.filter((row) => row.tokenId === USAGE_NUL_ONLY_TOKEN_ID);
  const unattributed = all.rows.filter((row) => row.tokenId === undefined);
  if (
    all.rows.length !== 2 ||
    marked.length !== 1 ||
    marked[0]?.managerId !== 'mgr-a' ||
    unattributed.length !== 1 ||
    unattributed[0]?.managerId !== 'mgr-b'
  ) {
    fail('NUL だけの tokenId が固定の目印で記録されず、帰属なしと区別がつかない', all.rows);
  }
  if (all.unmeteredRows?.[0]?.tokenId !== USAGE_NUL_ONLY_TOKEN_ID) {
    fail('無報告の行の NUL だけの tokenId が固定の目印で記録されていない', all.unmeteredRows);
  }
  for (const tokenId of ['\u0000', '\u0000\u0000', USAGE_NUL_ONLY_TOKEN_ID]) {
    const byMark = await usage.aggregate({ tokenId });
    if (
      byMark.rows.length !== 1 ||
      byMark.rows[0]?.managerId !== 'mgr-a' ||
      byMark.turnRows.length !== 1 ||
      byMark.turnRows[0]?.managerId !== 'mgr-a'
    ) {
      fail(
        `NUL だけの tokenId の絞り込みが目印の行だけを返さない（${JSON.stringify(tokenId)}）`,
        byMark,
      );
    }
  }

  await usage.clear();
}
