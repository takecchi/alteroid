import type { UsageBreakdown, UsageRow, UsageTotals } from './usage.js';

/**
 * 台帳の数字を読める形にするための算術と整形。
 *
 * **実行時の依存を1つも持たない**（型は `usage.ts` から `import type` で取るので
 * ビルド時に消える）。これは意図的な分離である — `@alteroid/core/usage` として
 * subpath で出しており、**ブラウザ（apps/web）はここだけを読む。**
 *
 * `index.ts` 経由で読ませると、Node の組み込み（`node:fs` / `node:child_process`）と
 * Claude Agent SDK を含む core 全体（gzip 約 300KB）がダッシュボードの初期チャンクへ
 * 入る。「金額を4桁で整形して足す」ためにそれを毎回読ませるのは、画面を開く人への
 * 実害である。
 *
 * **それでも算術は1つに保つ。** 口ごとに足し直すと「CLI では $3 なのに画面では
 * $2.9」という形で信用を失う。だから web 専用に書き写すのではなく、**同じ実装を
 * 軽い口から出す**。
 */

/**
 * 数字を見せるときに必ず添える但し書き。**どの口でも落とさないこと。**
 *
 * SDK の型コメントが `An estimate, not a billing statement` と明記している。
 * 台帳に積んだ値を確定として見せると、それは黙って嘘をつくことになる。
 */
export const USAGE_ESTIMATE_NOTICE =
  'SDK が返す推定値であり、Anthropic の請求明細ではない（一致しないことがある）。';

export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUsd: 0,
};

/** 行の合計（モデル横断・日横断）。表示側の算術をここへ寄せる。 */
export function sumUsageRows(rows: readonly UsageRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.totals.inputTokens,
      outputTokens: sum.outputTokens + row.totals.outputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + row.totals.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + row.totals.cacheCreationInputTokens,
      webSearchRequests: sum.webSearchRequests + row.totals.webSearchRequests,
      costUsd: sum.costUsd + row.totals.costUsd,
    }),
    { ...ZERO_USAGE },
  );
}

function groupBy<K extends string>(
  rows: readonly UsageRow[],
  key: (row: UsageRow) => string,
  label: K,
): Array<{ [P in K]: string } & { totals: UsageTotals }> {
  const buckets = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const id = key(row);
    const found = buckets.get(id);
    if (found) found.push(row);
    else buckets.set(id, [row]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, group]) => ({ [label]: id, totals: sumUsageRows(group) })) as Array<
    { [P in K]: string } & { totals: UsageTotals }
  >;
}

/** 行を3軸（日 / マネージャー / モデル）へ畳む。 */
export function summarizeUsage(rows: readonly UsageRow[]): UsageBreakdown {
  return {
    total: sumUsageRows(rows),
    byDate: groupBy(rows, (row) => row.date, 'date'),
    byManager: groupBy(rows, (row) => row.managerId, 'managerId'),
    byModel: groupBy(rows, (row) => row.model, 'model'),
  };
}

/**
 * 金額の表示（USD）。**$1 未満は 4 桁**まで出す。
 *
 * 委譲1本の費用はふつう $1 を大きく下回るので、2 桁に丸めると `$0.00` になって
 * 「使っていない」と読める。**取れている数字を丸めて消さない。**
 */
export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/**
 * ローカル時刻の `YYYY-MM-DD`。
 *
 * **UTC で切らない。** 日報（`ALTEROID_DAILY_REPORT_AT`）がローカル時刻で動くので、
 * ここを UTC にすると「今日いくら使ったか」と日報の「今日」がずれる。
 */
export function usageDate(at: Date): string {
  const y = at.getFullYear();
  const m = `${at.getMonth() + 1}`.padStart(2, '0');
  const d = `${at.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}
