import { USAGE_ESTIMATE_NOTICE, foldUsageSnapshot, usageDate } from '@alteroid/core';
import type {
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageQuery,
  UsageRow,
  UsageSnapshot,
  UsageStore,
  UsageTotals,
} from '@alteroid/core';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso, toNumber } from './db.js';
import { usageBaseline, usageDaily, usageLedger } from './schema.js';

/** `usage_ledger` は単一行。id はこの値に固定する。 */
const LEDGER_ID = 'default';

function optionalIso(value: Date | null): string | undefined {
  return value === null ? undefined : toIso(value);
}

/**
 * 照会範囲の一部でも台帳の始点より前にかかっていたか。
 *
 * 台帳が一度も record していなければ（`since === null`）、始まっている期間が
 * そもそも無いので常に真。始まっていても、下限の無い照会（`from` 省略）は
 * その前を含みうるので真。下限があるときだけ、始点の日付と比べる。
 */
function isBeforeLedger(since: string | null, from: string | undefined): boolean {
  if (since === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(since));
}

/**
 * 利用状況の台帳（PostgreSQL）。fs ドライバ（`@alteroid/storage-fs`）と同じ IF を
 * 満たす別の器であって、能力の差を作らない（`store.ts`「省略可能にしないこと」）。
 *
 * **`record` は読み・畳み・書きを1つのトランザクションに閉じる。** 基準を読んで
 * から増分を書くまでの隙間を空けると、同じマネージャーの次の result がそこへ
 * 割り込み、同じ増分が2回積まれる（`auth-service` の `claimLoginRequest` と同じ
 * 形の不変条件 — CLAUDE.md「不変条件はストアの1操作に閉じること」）。
 */
export class PgUsageStore implements UsageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async record(input: {
    managerId: string;
    date: string;
    at: string;
    snapshot: UsageSnapshot;
  }): Promise<UsageFold> {
    return this.#db.transaction(async (tx) => {
      // 台帳の開始時刻。**最初の record で1度だけ**入れる（衝突すれば何もしない
      // ＝既にあれば上書きしない）。
      await tx
        .insert(usageLedger)
        .values({ id: LEDGER_ID, startedAt: new Date(input.at) })
        .onConflictDoNothing({ target: usageLedger.id });

      // 差分計算は自分で書かない。foldUsageSnapshot に任せる（ロジックを二重に
      // 持たない）。基準の読みと増分の書きを同じトランザクションに収めることで、
      // 隙間に次の result が割り込む余地を無くす。
      const baselineRows = await tx
        .select()
        .from(usageBaseline)
        .where(eq(usageBaseline.managerId, input.managerId))
        .limit(1);
      const baseline = baselineRows[0] === undefined ? null : this.#toBaseline(baselineRows[0]);

      const fold = foldUsageSnapshot(baseline, input.snapshot, input.at);
      // foldUsageSnapshot は基準が無ければ managerId を空文字にする
      // （呼び出し側が知っている値を後から入れる契約 — usage.ts 参照）。
      const nextBaseline: UsageBaseline = { ...fold.baseline, managerId: input.managerId };

      const baselineSet = {
        sessionId: nextBaseline.sessionId ?? null,
        models: stripNulls(nextBaseline.models),
        updatedAt: new Date(nextBaseline.updatedAt),
        resets: nextBaseline.resets,
        lastResetAt:
          nextBaseline.lastResetAt === undefined ? null : new Date(nextBaseline.lastResetAt),
      };
      await tx
        .insert(usageBaseline)
        .values({ managerId: input.managerId, ...baselineSet })
        .onConflictDoUpdate({ target: usageBaseline.managerId, set: baselineSet });

      // 増分を日次へ足し込む。foldUsageSnapshot が既に増えていないモデルを
      // delta から落としているので、ここでも 0 の行は作らない。
      for (const [model, totals] of Object.entries(fold.delta)) {
        const updatedAt = new Date(input.at);
        const values = stripNulls({
          date: input.date,
          managerId: input.managerId,
          model,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadInputTokens: totals.cacheReadInputTokens,
          cacheCreationInputTokens: totals.cacheCreationInputTokens,
          webSearchRequests: totals.webSearchRequests,
          costUsd: totals.costUsd,
        });

        await tx
          .insert(usageDaily)
          .values({ ...values, updatedAt })
          .onConflictDoUpdate({
            target: [usageDaily.date, usageDaily.managerId, usageDaily.model],
            set: {
              // **足し込む（上書きではない）。** 同じ日にもう1回 result が来ても、
              // 先に記録した分を消さずに増分だけ乗せる。
              inputTokens: sql`${usageDaily.inputTokens} + excluded.input_tokens`,
              outputTokens: sql`${usageDaily.outputTokens} + excluded.output_tokens`,
              cacheReadInputTokens: sql`${usageDaily.cacheReadInputTokens} + excluded.cache_read_input_tokens`,
              cacheCreationInputTokens: sql`${usageDaily.cacheCreationInputTokens} + excluded.cache_creation_input_tokens`,
              webSearchRequests: sql`${usageDaily.webSearchRequests} + excluded.web_search_requests`,
              costUsd: sql`${usageDaily.costUsd} + excluded.cost_usd`,
              updatedAt,
            },
          });
      }

      return { delta: fold.delta, baseline: nextBaseline, reset: fold.reset };
    });
  }

  async aggregate(query: UsageQuery): Promise<UsageAggregate> {
    const conditions = [
      ...(query.from === undefined ? [] : [gte(usageDaily.date, query.from)]),
      ...(query.to === undefined ? [] : [lte(usageDaily.date, query.to)]),
      ...(query.managerId === undefined ? [] : [eq(usageDaily.managerId, query.managerId)]),
    ];

    const rows = await this.#db
      .select()
      .from(usageDaily)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(usageDaily.date), asc(usageDaily.managerId), asc(usageDaily.model));

    const ledgerRows = await this.#db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.id, LEDGER_ID))
      .limit(1);
    const since = ledgerRows[0] === undefined ? null : toIso(ledgerRows[0].startedAt);

    return {
      rows: rows.map((row) => this.#toRow(row)),
      since,
      beforeLedger: isBeforeLedger(since, query.from),
      notice: USAGE_ESTIMATE_NOTICE,
    };
  }

  async baseline(managerId: string): Promise<UsageBaseline | null> {
    const rows = await this.#db
      .select()
      .from(usageBaseline)
      .where(eq(usageBaseline.managerId, managerId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toBaseline(row);
  }

  #toRow(row: typeof usageDaily.$inferSelect): UsageRow {
    return {
      date: row.date,
      managerId: row.managerId,
      model: row.model,
      totals: {
        // bigint 列は toNumber を必ず通す（db.ts のコメント参照）。素通しで返すと
        // 文字列のままの経路が残り、sumUsageRows の `+` が連結になりかねない。
        inputTokens: toNumber(row.inputTokens),
        outputTokens: toNumber(row.outputTokens),
        cacheReadInputTokens: toNumber(row.cacheReadInputTokens),
        cacheCreationInputTokens: toNumber(row.cacheCreationInputTokens),
        webSearchRequests: toNumber(row.webSearchRequests),
        costUsd: row.costUsd,
      },
      updatedAt: toIso(row.updatedAt),
    };
  }

  #toBaseline(row: typeof usageBaseline.$inferSelect): UsageBaseline {
    return {
      managerId: row.managerId,
      sessionId: row.sessionId ?? undefined,
      models: row.models as Record<string, UsageTotals>,
      updatedAt: toIso(row.updatedAt),
      resets: row.resets,
      lastResetAt: optionalIso(row.lastResetAt),
    };
  }
}
