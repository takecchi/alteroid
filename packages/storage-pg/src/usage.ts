import {
  USAGE_ESTIMATE_NOTICE,
  foldOneshotUsage,
  foldUsageSnapshot,
  usageDate,
  usageLayerSchema,
  usageSiteSchema,
} from '@alteroid/core';
import type {
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageLayer,
  UsageQuery,
  UsageRow,
  UsageSite,
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
 * 照会範囲の一部でも**層と場所の軸**の始点より前にかかっていたか。
 *
 * `isBeforeLedger` と同じ形だが、守っているものが違う — あちらは「合計が 0 なのか
 * 記録が無いのか」、こちらは「層と場所の内訳が本物の観測か、後から入れた既定値か」
 * である。層の軸は台帳より後から入ったので、それより前の行は全部 `manager` /
 * `session` に見える。それは「クローンが使っていなかった」ではない。
 */
function isBeforeLayers(layersSince: string | null, from: string | undefined): boolean {
  if (layersSince === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(layersSince));
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
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    accumulation: UsageAccumulation;
  }): Promise<UsageFold> {
    return this.#db.transaction(async (tx) => {
      // 台帳の開始時刻。**最初の record で1度だけ**入れる（衝突すれば何もしない
      // ＝既にあれば上書きしない）。層の軸の始点は別に持つ — 台帳が先に始まって
      // いる DB では別の時刻になるので、`coalesce` で「まだ無ければ入れる」にする。
      await tx
        .insert(usageLedger)
        .values({ id: LEDGER_ID, startedAt: new Date(input.at), layeredAt: new Date(input.at) })
        .onConflictDoUpdate({
          target: usageLedger.id,
          // **`startedAt` は触らない。** 触ると台帳の始点が毎回いまになる。
          set: { layeredAt: sql`coalesce(${usageLedger.layeredAt}, excluded.layered_at)` },
        });

      // **累積の器は `query()` 呼び出しの寿命で閉じる**（`usage.ts` の
      // `usageAccumulationSchema`）。1回で閉じる呼び出しに基準を持たせると、前回より
      // 高くついた回だけが差に縮んで黙って目減りする（`foldOneshotUsage`）。
      //
      // 差分計算は自分で書かない（ロジックを二重に持たない）。基準の読みと増分の
      // 書きを同じトランザクションに収めることで、隙間に次の result が割り込む
      // 余地を無くす。
      const baselineRows =
        input.accumulation === 'oneshot'
          ? []
          : await tx
              .select()
              .from(usageBaseline)
              .where(
                and(
                  eq(usageBaseline.layer, input.layer),
                  eq(usageBaseline.managerId, input.managerId),
                ),
              )
              .limit(1);
      const baseline = baselineRows[0] === undefined ? null : this.#toBaseline(baselineRows[0]);

      const fold =
        input.accumulation === 'oneshot'
          ? foldOneshotUsage(input.snapshot)
          : foldUsageSnapshot(baseline, input.snapshot, input.at);
      // foldUsageSnapshot は基準が無ければ layer / managerId を空で返す
      // （呼び出し側が知っている値を後から入れる契約 — usage.ts 参照）。
      const nextBaseline: UsageBaseline | null =
        fold.baseline === null
          ? null
          : { ...fold.baseline, layer: input.layer, managerId: input.managerId };

      if (nextBaseline !== null) {
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
          .values({ layer: input.layer, managerId: input.managerId, ...baselineSet })
          .onConflictDoUpdate({
            target: [usageBaseline.layer, usageBaseline.managerId],
            set: baselineSet,
          });
      }

      // 増分を日次へ足し込む。foldUsageSnapshot が既に増えていないモデルを
      // delta から落としているので、ここでも 0 の行は作らない。
      for (const [model, totals] of Object.entries(fold.delta)) {
        const updatedAt = new Date(input.at);
        const values = stripNulls({
          date: input.date,
          managerId: input.managerId,
          model,
          layer: input.layer,
          site: input.site,
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
            // **層と場所を鍵から外さないこと。** 外すと同じ日・同じ actor・同じ
            // モデルの別の層の増分が先にある行へ足し込まれ、layer / site は先に
            // 入った側の値のまま残る（出力から見分けられない誤帰属になる）。
            target: [
              usageDaily.date,
              usageDaily.managerId,
              usageDaily.model,
              usageDaily.layer,
              usageDaily.site,
            ],
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
      ...(query.layer === undefined ? [] : [eq(usageDaily.layer, query.layer)]),
      ...(query.site === undefined ? [] : [eq(usageDaily.site, query.site)]),
    ];

    const rows = await this.#db
      .select()
      .from(usageDaily)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(
        asc(usageDaily.date),
        asc(usageDaily.managerId),
        asc(usageDaily.model),
        asc(usageDaily.layer),
        asc(usageDaily.site),
      );

    const ledgerRows = await this.#db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.id, LEDGER_ID))
      .limit(1);
    const ledger = ledgerRows[0];
    const since = ledger === undefined ? null : toIso(ledger.startedAt);
    const layersSince =
      ledger === undefined || ledger.layeredAt === null ? null : toIso(ledger.layeredAt);

    return {
      rows: rows.map((row) => this.#toRow(row)),
      since,
      layersSince,
      beforeLedger: isBeforeLedger(since, query.from),
      beforeLayers: isBeforeLayers(layersSince, query.from),
      notice: USAGE_ESTIMATE_NOTICE,
    };
  }

  async baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null> {
    const rows = await this.#db
      .select()
      .from(usageBaseline)
      .where(and(eq(usageBaseline.layer, layer), eq(usageBaseline.managerId, managerId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toBaseline(row);
  }

  #toRow(row: typeof usageDaily.$inferSelect): UsageRow {
    return {
      date: row.date,
      managerId: row.managerId,
      model: row.model,
      // **列は text である。** 型の上では任意の文字列が来うるので、読むときに
      // 一度通す（想定外の値が入っていれば黙って通さずここで落ちる）。
      layer: usageLayerSchema.parse(row.layer),
      site: usageSiteSchema.parse(row.site),
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
      layer: usageLayerSchema.parse(row.layer),
      managerId: row.managerId,
      sessionId: row.sessionId ?? undefined,
      models: row.models as Record<string, UsageTotals>,
      updatedAt: toIso(row.updatedAt),
      resets: row.resets,
      lastResetAt: optionalIso(row.lastResetAt),
    };
  }
}
