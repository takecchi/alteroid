import { z } from 'zod';

/**
 * Claude の利用状況の台帳（消費した側の記録）。
 *
 * **ここに置くのは「alteroid が使った分」だけである。** アカウント全体の残り枠と
 * 支出上限は claude.ai 側の値で、`usage-snapshot.ts` が別に読む。**2つを足したり
 * 混ぜたりしないこと** — 前者は自分で数えた推定値、後者は向こうが言っている値で、
 * 一致する保証がない。
 *
 * ## 出所は `modelUsage` であって `usage` ではない
 *
 * SDK の `result` は両方を運ぶが、`usage` には型のコメントで
 * **「MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain ... Prefer
 * modelUsage for token/cost accounting」** と書いてある。alteroid は委譲が主役
 * （クローン → マネージャー → 作業者）なので、`usage` を採ると**作業者の消費が
 * 丸ごと落ちる**。落ちるのは階層の末端＝いちばん数が多い層である。
 *
 * ## 累積値は足してはいけない
 *
 * 同じ型のコメントにこうある —
 * **「cumulative across turns in streaming-input sessions — each result carries
 * the running total so far, so read the latest result rather than summing across
 * results」**。マネージャーは streaming-input で長く走るので、ターンごとの
 * `result` を足すと二重計上になる。**差分を取る。**
 *
 * さらに同じコメントが3つの落とし穴を明示している。
 *
 * - `resumed sessions start fresh` — alteroid はデーモン再起動で resume する
 *   （AGENTS.md「デーモン再起動時の引き取りは2通り」）ので、**必ず踏む**
 * - `a mid-session /clear resets the running total`
 * - `crash/startup-error results may carry zeroed values`
 *
 * 最後のものが一番危ない。ゼロを「累積が 0 になった」として採用すると、記録済みの
 * 消費が消える。**失敗が成功として観測されるのと同じ形の壊れ方**である。だから
 * **成功した `result` の値しか台帳へ入れない**（`runner.ts` の呼び出し側で絞る）。
 * ここまで絞れば、残る減少は resume か `/clear` — どちらも「新しい累積が 0 から
 * 始まった」なので、{@link foldUsageSnapshot} は減少を数え直しとして扱える。
 *
 * ## 推定値である
 *
 * 型のコメントに **「An estimate, not a billing statement」** と明記されている。
 * **この一文を落とさないこと。** 台帳の数字を見せる口（API / CLI / Web / クローンの
 * 道具）はすべて {@link USAGE_ESTIMATE_NOTICE} を一緒に運ぶ。
 */

/** 数字を見せるときに必ず添える但し書き。**どの口でも落とさないこと。** */
export const USAGE_ESTIMATE_NOTICE =
  'SDK が返す推定値であり、Anthropic の請求明細ではない（一致しないことがある）。';

const isoDateTime = z.string().datetime({ offset: true });

/** 日付。ローカル時刻の `YYYY-MM-DD`（日報と同じ区切りに合わせる）。 */
export const usageDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD で書く');

/**
 * 1つの区切りぶんの消費量。トークンは整数、費用は USD。
 *
 * SDK の `ModelUsage` の写しだが、**`contextWindow` / `maxOutputTokens` は持たない**
 * （あれはモデルの仕様であって消費量ではない。台帳に混ぜると集計で足されうる）。
 */
export const usageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  webSearchRequests: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUsd: 0,
};

/**
 * `result.modelUsage` をそのまま写した、その時点の**累積**。
 *
 * **これは事実であって解釈ではない。** runner から降りてくるのはこの形で、差分に
 * するのはデーモン側である（runner-protocol.ts「ここに流れるのは事実だけである」）。
 * 差分を runner で作ると、イベントが再送されたときに二重計上になる — 累積値なら
 * 同じものが2回届いても増分が 0 になるだけで済む。
 */
export const usageSnapshotSchema = z.object({
  /**
   * SDK のセッション id。累積が数え直された事実の記録に添えるためだけに持つ。
   *
   * **これで数え直しを判定しないこと。** resume は同じ session id のまま累積を
   * 0 に戻すので、session id が変わったかどうかは判定材料にならない。
   */
  sessionId: z.string().optional(),
  /** モデル id → その時点の累積。 */
  models: z.record(z.string(), usageTotalsSchema),
});

export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

/** 前回読んだ累積（差分を取るための基準）。マネージャー1本につき1つ。 */
export const usageBaselineSchema = z.object({
  managerId: z.string(),
  sessionId: z.string().optional(),
  models: z.record(z.string(), usageTotalsSchema),
  updatedAt: isoDateTime,
  /** 数え直しを検知した回数。**黙って数え直さない**ための記録。 */
  resets: z.number().int().nonnegative(),
  lastResetAt: isoDateTime.optional(),
});

export type UsageBaseline = z.infer<typeof usageBaselineSchema>;

/**
 * 累積が数え直された事実。
 *
 * **黙って数え直すと、後から「なぜ集計が飛んでいるか」が分からない。** 起きたことは
 * 起きたこととして残す（日誌にも落とす）。
 */
export const usageResetSchema = z.object({
  at: isoDateTime,
  /** 数え直し前の累積費用の合計（USD）。どれだけの高さから落ちたか。 */
  fromCostUsd: z.number().nonnegative(),
  /** 数え直し後の累積費用の合計（USD）。 */
  toCostUsd: z.number().nonnegative(),
  /** 直前の session id と今の session id（変わっていれば別セッションで開き直した）。 */
  fromSessionId: z.string().optional(),
  toSessionId: z.string().optional(),
});

export type UsageReset = z.infer<typeof usageResetSchema>;

/** {@link foldUsageSnapshot} の結果。 */
export interface UsageFold {
  /** 台帳へ加算する増分（モデル id → 増分）。**負にはならない。** */
  delta: Record<string, UsageTotals>;
  /** 次回の基準。 */
  baseline: UsageBaseline;
  /** 数え直しが起きたならその事実。起きていなければ undefined。 */
  reset?: UsageReset;
}

function sumCostUsd(models: Record<string, UsageTotals>): number {
  return Object.values(models).reduce((sum, m) => sum + m.costUsd, 0);
}

/**
 * 累積が数え直されたか。
 *
 * 判定は2つ。**どれか1つのモデルでも減った**か、**基準にあったモデルが消えた**か。
 * どちらも「別の累積が始まった」ことを意味する。session id は見ない（resume は
 * 同じ id のまま 0 に戻る）。
 */
function detectReset(
  prev: Record<string, UsageTotals>,
  next: Record<string, UsageTotals>,
): boolean {
  for (const [model, before] of Object.entries(prev)) {
    const after = next[model];
    if (after === undefined) return true;
    if (
      after.inputTokens < before.inputTokens ||
      after.outputTokens < before.outputTokens ||
      after.cacheReadInputTokens < before.cacheReadInputTokens ||
      after.cacheCreationInputTokens < before.cacheCreationInputTokens ||
      after.webSearchRequests < before.webSearchRequests ||
      after.costUsd < before.costUsd
    ) {
      return true;
    }
  }
  return false;
}

function subtract(after: UsageTotals, before: UsageTotals): UsageTotals {
  // **引き算で負にしない。** 減少は上で数え直しとして扱っているので通常ここへは
  // 来ないが、片方のフィールドだけが動く形の値が来ても台帳を汚さないようにする。
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadInputTokens: Math.max(0, after.cacheReadInputTokens - before.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(
      0,
      after.cacheCreationInputTokens - before.cacheCreationInputTokens,
    ),
    webSearchRequests: Math.max(0, after.webSearchRequests - before.webSearchRequests),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
  };
}

function isZero(totals: UsageTotals): boolean {
  return (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.cacheReadInputTokens === 0 &&
    totals.cacheCreationInputTokens === 0 &&
    totals.webSearchRequests === 0 &&
    totals.costUsd === 0
  );
}

/** 1つでも動いているモデルがあるか（空の記録と、本当にゼロの記録を区別する）。 */
function hasAnyUsage(models: Record<string, UsageTotals>): boolean {
  return Object.values(models).some((totals) => !isZero(totals));
}

/**
 * 累積スナップショットを増分へ畳む。**純関数**（ストアはこれを1操作の中で使う）。
 *
 * 数え直しを検知したときの増分は **スナップショットの全量** である。0 ではない。
 * 新しい累積は 0 から始まっているので、そこに載っている分はまだ台帳に無い消費で
 * ある。ここを 0 にすると、resume 後の1回目のターンぶんが黙って消える。
 *
 * 例: 累積 $5.00 まで記録 → resume で 0 に戻る → 次に読めた累積が $3.00
 *  → 数え直しとして $3.00 を加算する。台帳の合計は $8.00 で、実際に使った額と合う。
 *
 * **全部ゼロのスナップショットは「情報なし」として捨てる**（基準を持っているとき）。
 * SDK は `crash/startup-error results may carry zeroed values` と言っている。ゼロを
 * 数え直しとして採用すると基準が 0 まで下がり、**次に届いた本物の累積がまるごと
 * 増分になって二重計上になる**（記録済みの $5.00 がもう一度積まれる）。
 *
 * 捨てても取りこぼさない。累積値だからである — 本物の resume なら次に届く非ゼロの
 * 累積が基準より低いので、そこで数え直しとして正しく拾える。クラッシュの記録なら
 * 次の成功が同じ累積を運んでくるので増分 0 で済む。**どちらの経路も正しくなる。**
 */
export function foldUsageSnapshot(
  baseline: UsageBaseline | null,
  snapshot: UsageSnapshot,
  at: string,
): UsageFold {
  const prev = baseline?.models ?? {};
  const next = snapshot.models;

  if (baseline !== null && hasAnyUsage(prev) && !hasAnyUsage(next)) {
    return { delta: {}, baseline };
  }

  const reset = baseline !== null && detectReset(prev, next);

  const delta: Record<string, UsageTotals> = {};
  for (const [model, totals] of Object.entries(next)) {
    const increment = reset ? totals : subtract(totals, prev[model] ?? ZERO_USAGE);
    // 増えていないモデルの行を作らない（台帳が 0 の行で埋まる）。
    if (!isZero(increment)) delta[model] = increment;
  }

  return {
    delta,
    baseline: {
      managerId: baseline?.managerId ?? '',
      sessionId: snapshot.sessionId ?? baseline?.sessionId,
      models: next,
      updatedAt: at,
      resets: (baseline?.resets ?? 0) + (reset ? 1 : 0),
      lastResetAt: reset ? at : baseline?.lastResetAt,
    },
    reset: reset
      ? {
          at,
          fromCostUsd: sumCostUsd(prev),
          toCostUsd: sumCostUsd(next),
          fromSessionId: baseline?.sessionId,
          toSessionId: snapshot.sessionId,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// 台帳の行と問い合わせ
// ---------------------------------------------------------------------------

/**
 * 台帳の1行。**日 × マネージャー × モデル**の3軸で、増分を足し込んだもの。
 *
 * 3軸とも要る — 「今日いくら使ったか」（日）、「どの委譲が高かったか」
 * （マネージャー）、「どの層が高いか」（モデル = Fable / Opus / Sonnet）。
 */
export const usageRowSchema = z.object({
  date: usageDateSchema,
  managerId: z.string(),
  model: z.string(),
  totals: usageTotalsSchema,
  updatedAt: isoDateTime,
});

export type UsageRow = z.infer<typeof usageRowSchema>;

export const usageQuerySchema = z.object({
  /** この日以降（含む）。 */
  from: usageDateSchema.optional(),
  /** この日まで（含む）。 */
  to: usageDateSchema.optional(),
  /** このマネージャーだけ。 */
  managerId: z.string().optional(),
});

export type UsageQuery = z.infer<typeof usageQuerySchema>;

/**
 * 集計の答え。
 *
 * **`since` を必ず添える。** 台帳が始まる前を照会されたら 0 ではなく「記録が無い」と
 * 言えるようにするためである。過去分の掘り起こしはやらないと決めた（SDK が推定と
 * 言っている計算を、単価を自前で掛けて二重に推定し直すことになる。当時の単価を
 * 正しく持つのも無理）。だからこそ**始点を黙って隠さない**。
 */
export const usageAggregateSchema = z.object({
  rows: z.array(usageRowSchema),
  /** 台帳が記録を始めた時刻。1件も記録していなければ null。 */
  since: isoDateTime.nullable(),
  /**
   * 照会された範囲の一部（または全部）が台帳の始点より前だったか。
   *
   * **真なら「その範囲は 0 ではなく記録が無い」と言うこと。** 数字だけを見せると、
   * 台帳が無かった期間が「使っていない期間」に見える。
   */
  beforeLedger: z.boolean(),
  /** 数字に必ず添える但し書き。 */
  notice: z.literal(USAGE_ESTIMATE_NOTICE),
});

export type UsageAggregate = z.infer<typeof usageAggregateSchema>;

/**
 * 3軸それぞれの内訳。**4つの口（API / CLI / Web / クローンの道具）が共有する。**
 *
 * 各口で足し直すと、どれか1つの丸め方や取りこぼしが他と食い違い、「CLI では
 * $3 なのに画面では $2.9」という形で信用を失う。算術はここに1つだけ置く。
 */
export const usageBreakdownSchema = z.object({
  total: usageTotalsSchema,
  byDate: z.array(z.object({ date: usageDateSchema, totals: usageTotalsSchema })),
  byManager: z.array(z.object({ managerId: z.string(), totals: usageTotalsSchema })),
  /** どの層（Fable / Opus / Sonnet）で使ったか。 */
  byModel: z.array(z.object({ model: z.string(), totals: usageTotalsSchema })),
});

export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;

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

/** 行を3軸へ畳む。 */
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
