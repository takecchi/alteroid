import type { UsageStore } from './store.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageLayer, UsageQuery, UsageSite } from './usage.js';

// 3実装（インメモリ / fs / pg）が `aggregate()` の3つの表（日ごと・ターン・測れなかった行）を同じ条件で絞り、同じ並びで返すことを測る
// 同じ店に他の記録が在っても通るように、自分が書いた managerId の行だけを見る
// 並びは UTF-16 のコード単位順（pg は `collate "C"`）で、帰属（tokenId）の無い行は最後。U+FFFF の tokenId は、番兵で代用すると帰属の無い行と並びが入れ替わるので入れてある
// 補助面（U+10000 以上）の文字は入れない: コード単位順と pg のバイト順はそこで割れる（この契約が測る範囲の外）

const M1 = 'mgr-usage-query-1';
const M2 = 'mgr-usage-query-2';

interface Key {
  date: string;
  managerId: string;
  layer: UsageLayer;
  site: UsageSite;
  tokenId?: string | undefined;
}
interface RowKey extends Key {
  model: string;
}
interface UnmeteredKey extends Key {
  provider: string;
}

const key = (
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId?: string,
): Key => ({ date, managerId, layer, site, tokenId });

interface Seed extends Key {
  provider: string;
  models: string[];
}

// 並びをわざと崩した入れ順で書く。期待の並びは下の EXPECTED_* に文字どおり書く
const SEEDS: Seed[] = [
  { ...key('2026-08-14', M1, 'manager', 'session', 't2'), provider: 'alpha', models: ['opus'] },
  { ...key('2026-08-12', M2, 'clone', 'session', 't2'), provider: 'beta', models: ['opus'] },
  { ...key('2026-08-12', M1, 'manager', 'session'), provider: 'alpha', models: ['opus'] },
  { ...key('2026-08-14', M2, 'clone', 'peer', 't1'), provider: 'beta', models: ['opus'] },
  { ...key('2026-08-12', M1, 'manager', 'session', '￿'), provider: 'alpha', models: ['opus'] },
  { ...key('2026-08-11', M1, 'clone', 'session'), provider: 'beta', models: ['opus'] },
  { ...key('2026-08-12', M1, 'manager', 'distill'), provider: 'alpha', models: ['opus'] },
  {
    ...key('2026-08-12', M1, 'manager', 'session', 't1'),
    provider: 'alpha',
    models: ['opus', 'haiku'],
  },
  { ...key('2026-08-10', M1, 'manager', 'session', 't1'), provider: 'alpha', models: ['opus'] },
  { ...key('2026-08-12', M2, 'manager', 'peer', 't2'), provider: 'beta', models: ['opus'] },
  { ...key('2026-08-12', M1, 'manager', 'session', 't1'), provider: 'aaa', models: ['opus'] },
];

const row = (k: Key, model: string): RowKey => ({ ...k, model });
const unmetered = (k: Key, provider: string): UnmeteredKey => ({ ...k, provider });

const K = {
  d10: key('2026-08-10', M1, 'manager', 'session', 't1'),
  d11: key('2026-08-11', M1, 'clone', 'session'),
  distill: key('2026-08-12', M1, 'manager', 'distill'),
  t1: key('2026-08-12', M1, 'manager', 'session', 't1'),
  fff: key('2026-08-12', M1, 'manager', 'session', '￿'),
  none: key('2026-08-12', M1, 'manager', 'session'),
  cloneM2: key('2026-08-12', M2, 'clone', 'session', 't2'),
  peerM2: key('2026-08-12', M2, 'manager', 'peer', 't2'),
  d14m1: key('2026-08-14', M1, 'manager', 'session', 't2'),
  d14m2: key('2026-08-14', M2, 'clone', 'peer', 't1'),
};

// 日付 → managerId → モデル → 層 → 場所 →（日ごとの行はここまで）→ 帰属の無い行は最後
const EXPECTED_ROWS: RowKey[] = [
  row(K.d10, 'opus'),
  row(K.d11, 'opus'),
  row(K.t1, 'haiku'),
  row(K.distill, 'opus'),
  row(K.t1, 'opus'),
  row(K.fff, 'opus'),
  row(K.none, 'opus'),
  row(K.cloneM2, 'opus'),
  row(K.peerM2, 'opus'),
  row(K.d14m1, 'opus'),
  row(K.d14m2, 'opus'),
];
const EXPECTED_TURNS: Key[] = [
  K.d10,
  K.d11,
  K.distill,
  K.t1,
  K.fff,
  K.none,
  K.cloneM2,
  K.peerM2,
  K.d14m1,
  K.d14m2,
];
// provider は場所の後・帰属の前
const EXPECTED_UNMETERED: UnmeteredKey[] = [
  unmetered(K.d10, 'alpha'),
  unmetered(K.d11, 'beta'),
  unmetered(K.distill, 'alpha'),
  unmetered(K.t1, 'aaa'),
  unmetered(K.t1, 'alpha'),
  unmetered(K.fff, 'alpha'),
  unmetered(K.none, 'alpha'),
  unmetered(K.cloneM2, 'beta'),
  unmetered(K.peerM2, 'beta'),
  unmetered(K.d14m1, 'alpha'),
  unmetered(K.d14m2, 'beta'),
];

// 期待の絞り込みは、条件ごとに手で書く（実装の関数を使わない）
const QUERIES: Array<{ name: string; query: UsageQuery; keep: (k: Key) => boolean }> = [
  { name: '絞らない', query: {}, keep: () => true },
  { name: 'from', query: { from: '2026-08-11' }, keep: (k) => k.date >= '2026-08-11' },
  { name: 'to', query: { to: '2026-08-12' }, keep: (k) => k.date <= '2026-08-12' },
  { name: 'managerId', query: { managerId: M2 }, keep: (k) => k.managerId === M2 },
  { name: 'layer', query: { layer: 'clone' }, keep: (k) => k.layer === 'clone' },
  { name: 'site', query: { site: 'peer' }, keep: (k) => k.site === 'peer' },
  { name: 'tokenId', query: { tokenId: 't1' }, keep: (k) => k.tokenId === 't1' },
  { name: 'tokenId（U+FFFF）', query: { tokenId: '￿' }, keep: (k) => k.tokenId === '￿' },
  {
    name: '全部の組み合わせ',
    query: {
      from: '2026-08-11',
      to: '2026-08-12',
      managerId: M1,
      layer: 'manager',
      site: 'session',
      tokenId: 't1',
    },
    keep: (k) =>
      k.date >= '2026-08-11' &&
      k.date <= '2026-08-12' &&
      k.managerId === M1 &&
      k.layer === 'manager' &&
      k.site === 'session' &&
      k.tokenId === 't1',
  },
];

export async function verifyUsageQueryContract(usage: UsageStore): Promise<void> {
  function fail(message: string, detail?: unknown): never {
    throw new Error(
      `UsageStore の絞り込み・並びの契約違反: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
  const mine = (row: { managerId: string }): boolean =>
    row.managerId === M1 || row.managerId === M2;
  // 帰属の無い行は tokenId の欄ごと無い: 空文字や null を返す器を見逃さないため、`undefined` のまま JSON に載せる（欄が落ちる）
  const shape = (r: Key & { model?: string; provider?: string }): unknown => ({
    date: r.date,
    managerId: r.managerId,
    ...(r.model === undefined ? {} : { model: r.model }),
    layer: r.layer,
    site: r.site,
    ...(r.provider === undefined ? {} : { provider: r.provider }),
    ...(r.tokenId === undefined ? {} : { tokenId: r.tokenId }),
  });

  for (const [i, seed] of SEEDS.entries()) {
    const at = `2026-08-20T10:00:${String(10 + i).padStart(2, '0')}.000Z`;
    const base = {
      layer: seed.layer,
      site: seed.site,
      managerId: seed.managerId,
      date: seed.date,
      at,
      ...(seed.tokenId === undefined ? {} : { tokenId: seed.tokenId }),
    };
    await usage.record({
      ...base,
      accumulation: 'oneshot',
      snapshot: {
        models: Object.fromEntries(
          seed.models.map((model) => [model, { ...ZERO_USAGE, outputTokens: 10 }]),
        ),
      },
    });
    await usage.recordUnmetered({ ...base, provider: seed.provider });
  }

  for (const { name, query, keep } of QUERIES) {
    const aggregate = await usage.aggregate(query);
    const rows = aggregate.rows.filter(mine).map(shape);
    const turnRows = aggregate.turnRows.filter(mine).map(shape);
    const unmeteredRows = (aggregate.unmeteredRows ?? []).filter(mine).map(shape);
    const expectedRows = EXPECTED_ROWS.filter(keep).map(shape);
    const expectedTurns = EXPECTED_TURNS.filter(keep).map(shape);
    const expectedUnmetered = EXPECTED_UNMETERED.filter(keep).map(shape);
    if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) {
      fail(`日ごとの行の絞り込みか並びが違う（${name}）`, { actual: rows, expected: expectedRows });
    }
    if (JSON.stringify(turnRows) !== JSON.stringify(expectedTurns)) {
      fail(`ターンの行の絞り込みか並びが違う（${name}）`, {
        actual: turnRows,
        expected: expectedTurns,
      });
    }
    if (JSON.stringify(unmeteredRows) !== JSON.stringify(expectedUnmetered)) {
      fail(`測れなかった行の絞り込みか並びが違う（${name}）`, {
        actual: unmeteredRows,
        expected: expectedUnmetered,
      });
    }
  }
}
