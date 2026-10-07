import {
  USAGE_ESTIMATE_NOTICE,
  stripNul,
  stripNulFromUnmeteredRecord,
  stripNulFromUsageQuery,
  stripNulFromUsageRecord,
  foldRecordForStore,
  isRealUsageDate,
  usageDate,
  usageLayerSchema,
  usageSiteSchema,
} from '@alteroid/core';
import type {
  UnreadableUsageRow,
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageRecordRunner,
  UsageLayer,
  UsageQuery,
  UsageRow,
  UsageSite,
  UsageSnapshot,
  UsageStore,
  UsageTotals,
  UsageTurnRow,
  UsageUnmeteredRow,
} from '@alteroid/core';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { byteOrder, stripNulls, toIso, toNumber } from './db.js';
import { usageBaseline, usageDaily, usageLedger, usageTurns, usageUnmetered } from './schema.js';

const LEDGER_ID = 'default';

// `layer` と `managerId` を `:` で連結して1本の鍵にする: `pg_advisory_xact_lock` は2引数までしか受けないため。
const USAGE_RECORD_LOCK_NAMESPACE = 'alteroid.usage.record';

function optionalIso(value: Date | null): string | undefined {
  return value === null ? undefined : toIso(value);
}

function unreadableCountsOf(row: {
  readonly unreadableInputTokens: number;
  readonly unreadableOutputTokens: number;
  readonly unreadableCacheReadInputTokens: number;
  readonly unreadableCacheCreationInputTokens: number;
  readonly unreadableWebSearchRequests: number;
  readonly unreadableCostUsd: number;
}): { unreadable?: UsageTotals['unreadable'] } {
  const unreadable: NonNullable<UsageTotals['unreadable']> = {};
  if (toNumber(row.unreadableInputTokens) > 0) {
    unreadable.inputTokens = toNumber(row.unreadableInputTokens);
  }
  if (toNumber(row.unreadableOutputTokens) > 0) {
    unreadable.outputTokens = toNumber(row.unreadableOutputTokens);
  }
  if (toNumber(row.unreadableCacheReadInputTokens) > 0) {
    unreadable.cacheReadInputTokens = toNumber(row.unreadableCacheReadInputTokens);
  }
  if (toNumber(row.unreadableCacheCreationInputTokens) > 0) {
    unreadable.cacheCreationInputTokens = toNumber(row.unreadableCacheCreationInputTokens);
  }
  if (toNumber(row.unreadableWebSearchRequests) > 0) {
    unreadable.webSearchRequests = toNumber(row.unreadableWebSearchRequests);
  }
  if (toNumber(row.unreadableCostUsd) > 0) {
    unreadable.costUsd = toNumber(row.unreadableCostUsd);
  }
  return Object.keys(unreadable).length > 0 ? { unreadable } : {};
}

function isBeforeLedger(since: string | null, from: string | undefined): boolean {
  if (since === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(since));
}

function isBeforeLayers(layersSince: string | null, from: string | undefined): boolean {
  if (layersSince === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(layersSince));
}

function isBeforeTokens(tokensSince: string | null, from: string | undefined): boolean {
  if (tokensSince === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(tokensSince));
}

function isBeforeTurns(turnsSince: string | null, from: string | undefined): boolean {
  if (turnsSince === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(turnsSince));
}

export class PgUsageStore implements UsageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async record(rawInput: {
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    accumulation: UsageAccumulation;
    tokenId?: string;
    runner?: UsageRecordRunner;
  }): Promise<UsageFold> {
    const input = stripNulFromUsageRecord(rawInput);
    return this.#db.transaction(async (tx) => {
      // トランザクションに閉じるだけにしない: READ COMMITTED では並行する2つの `record()` が同じ基準を読み、同じ増分を二重に加算するため。advisory lock で直列化する。
      // oneshot はロックを取らない: 基準を読まないため。
      if (input.accumulation !== 'oneshot') {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${USAGE_RECORD_LOCK_NAMESPACE}), hashtext(${input.layer} || ':' || ${input.managerId}))`,
        );
      }

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

      const { fold, nextBaseline } = foldRecordForStore(baseline, {
        layer: input.layer,
        managerId: input.managerId,
        snapshot: input.snapshot,
        at: input.at,
        accumulation: input.accumulation,
        ...(input.runner === undefined ? {} : { runner: input.runner }),
      });

      // 増分が空の record をターンとして数えない: 同じ累積スナップショットの再送などを1回と数えないため。
      const turned = Object.keys(fold.delta).length > 0;

      // トークンの軸を毎回入れない: プールを持たない器が「トークン軸を観測している」と名乗るため。`token_id` が付いた1件目でだけ始める。
      const tokensAt = input.tokenId === undefined ? null : new Date(input.at);
      const turnsAt = turned ? new Date(input.at) : null;
      await tx
        .insert(usageLedger)
        .values({
          id: LEDGER_ID,
          startedAt: new Date(input.at),
          layeredAt: new Date(input.at),
          tokensAt,
          turnsAt,
        })
        .onConflictDoUpdate({
          target: usageLedger.id,
          // `startedAt` を `set` に入れない: 台帳の始点が毎回いまになるため。
          set: {
            layeredAt: sql`coalesce(${usageLedger.layeredAt}, excluded.layered_at)`,
            tokensAt: sql`coalesce(${usageLedger.tokensAt}, excluded.tokens_at)`,
            turnsAt: sql`coalesce(${usageLedger.turnsAt}, excluded.turns_at)`,
          },
        });

      if (nextBaseline !== null) {
        const baselineSet = {
          sessionId: nextBaseline.sessionId ?? null,
          models: stripNulls(nextBaseline.models),
          updatedAt: new Date(nextBaseline.updatedAt),
          resets: nextBaseline.resets,
          lastResetAt:
            nextBaseline.lastResetAt === undefined ? null : new Date(nextBaseline.lastResetAt),
          byRunner: nextBaseline.byRunner === undefined ? null : stripNulls(nextBaseline.byRunner),
        };
        await tx
          .insert(usageBaseline)
          .values({ layer: input.layer, managerId: input.managerId, ...baselineSet })
          .onConflictDoUpdate({
            target: [usageBaseline.layer, usageBaseline.managerId],
            set: baselineSet,
          });
      }

      for (const [model, totals] of Object.entries(fold.delta)) {
        const updatedAt = new Date(input.at);
        const unreadable = totals.unreadable ?? {};
        const values = stripNulls({
          date: input.date,
          managerId: input.managerId,
          model,
          layer: input.layer,
          site: input.site,
          // null にしない: 一意索引が帰属の無い行を重複と見なさず、record のたびに新しい行が挿さるため。
          tokenId: input.tokenId ?? '',
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadInputTokens: totals.cacheReadInputTokens,
          cacheCreationInputTokens: totals.cacheCreationInputTokens,
          webSearchRequests: totals.webSearchRequests,
          costUsd: totals.costUsd,
          unreadableInputTokens: unreadable.inputTokens ?? 0,
          unreadableOutputTokens: unreadable.outputTokens ?? 0,
          unreadableCacheReadInputTokens: unreadable.cacheReadInputTokens ?? 0,
          unreadableCacheCreationInputTokens: unreadable.cacheCreationInputTokens ?? 0,
          unreadableWebSearchRequests: unreadable.webSearchRequests ?? 0,
          unreadableCostUsd: unreadable.costUsd ?? 0,
        });

        await tx
          .insert(usageDaily)
          .values({ ...values, updatedAt })
          .onConflictDoUpdate({
            // 層・場所・トークンを鍵から外さない: 別の層やトークンの増分が先にある行へ足し込まれ、出力から見分けられない誤帰属になるため。
            target: [
              usageDaily.date,
              usageDaily.managerId,
              usageDaily.model,
              usageDaily.layer,
              usageDaily.site,
              usageDaily.tokenId,
            ],
            set: {
              inputTokens: sql`${usageDaily.inputTokens} + excluded.input_tokens`,
              outputTokens: sql`${usageDaily.outputTokens} + excluded.output_tokens`,
              cacheReadInputTokens: sql`${usageDaily.cacheReadInputTokens} + excluded.cache_read_input_tokens`,
              cacheCreationInputTokens: sql`${usageDaily.cacheCreationInputTokens} + excluded.cache_creation_input_tokens`,
              webSearchRequests: sql`${usageDaily.webSearchRequests} + excluded.web_search_requests`,
              costUsd: sql`${usageDaily.costUsd} + excluded.cost_usd`,
              unreadableInputTokens: sql`${usageDaily.unreadableInputTokens} + excluded.unreadable_input_tokens`,
              unreadableOutputTokens: sql`${usageDaily.unreadableOutputTokens} + excluded.unreadable_output_tokens`,
              unreadableCacheReadInputTokens: sql`${usageDaily.unreadableCacheReadInputTokens} + excluded.unreadable_cache_read_input_tokens`,
              unreadableCacheCreationInputTokens: sql`${usageDaily.unreadableCacheCreationInputTokens} + excluded.unreadable_cache_creation_input_tokens`,
              unreadableWebSearchRequests: sql`${usageDaily.unreadableWebSearchRequests} + excluded.unreadable_web_search_requests`,
              unreadableCostUsd: sql`${usageDaily.unreadableCostUsd} + excluded.unreadable_cost_usd`,
              updatedAt,
            },
          });
      }

      // `usage_daily` と同じループの中で回さない: モデルが何本立っても1ターンにつき1だけ足すため。
      if (turned) {
        const updatedAt = new Date(input.at);
        const values = stripNulls({
          date: input.date,
          managerId: input.managerId,
          layer: input.layer,
          site: input.site,
          tokenId: input.tokenId ?? '',
        });
        await tx
          .insert(usageTurns)
          .values({ ...values, turns: 1, updatedAt })
          .onConflictDoUpdate({
            target: [
              usageTurns.date,
              usageTurns.managerId,
              usageTurns.layer,
              usageTurns.site,
              usageTurns.tokenId,
            ],
            set: {
              turns: sql`${usageTurns.turns} + 1`,
              updatedAt,
            },
          });
      }

      return {
        delta: fold.delta,
        baseline: nextBaseline,
        reset: fold.reset,
        ...(fold.skipped === undefined ? {} : { skipped: fold.skipped }),
      };
    });
  }

  async recordUnmetered(rawInput: {
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    provider: string;
    tokenId?: string;
  }): Promise<void> {
    const input = stripNulFromUnmeteredRecord(rawInput);
    const updatedAt = new Date(input.at);
    await this.#db
      .insert(usageUnmetered)
      .values({
        date: input.date,
        managerId: input.managerId,
        layer: input.layer,
        site: input.site,
        provider: input.provider,
        tokenId: input.tokenId ?? '',
        turns: 1,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          usageUnmetered.date,
          usageUnmetered.managerId,
          usageUnmetered.layer,
          usageUnmetered.site,
          usageUnmetered.provider,
          usageUnmetered.tokenId,
        ],
        set: { turns: sql`${usageUnmetered.turns} + 1`, updatedAt },
      });
  }

  async aggregate(rawQuery: UsageQuery): Promise<UsageAggregate> {
    // 絞り込みの NUL を落としてから引く: 渡すと PostgreSQL が NUL を含む text を受け付けずエラーで投げるため。
    const query = stripNulFromUsageQuery(rawQuery);
    const conditions = [
      ...(query.from === undefined ? [] : [gte(usageDaily.date, query.from)]),
      ...(query.to === undefined ? [] : [lte(usageDaily.date, query.to)]),
      ...(query.managerId === undefined ? [] : [eq(usageDaily.managerId, query.managerId)]),
      ...(query.layer === undefined ? [] : [eq(usageDaily.layer, query.layer)]),
      ...(query.site === undefined ? [] : [eq(usageDaily.site, query.site)]),
      ...(query.tokenId === undefined ? [] : [eq(usageDaily.tokenId, query.tokenId)]),
    ];

    const rows = await this.#db
      .select()
      .from(usageDaily)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(
        asc(byteOrder(usageDaily.date)),
        asc(byteOrder(usageDaily.managerId)),
        asc(byteOrder(usageDaily.model)),
        asc(byteOrder(usageDaily.layer)),
        asc(byteOrder(usageDaily.site)),
        // `asc(tokenId)` だけにしない: 空文字が昇順の先頭に来るため、`nullif` で null へ戻して帰属の無い行を最後に置く。
        sql`nullif(${usageDaily.tokenId}, '') collate "C" asc nulls last`,
      );

    const turnConditions = [
      ...(query.from === undefined ? [] : [gte(usageTurns.date, query.from)]),
      ...(query.to === undefined ? [] : [lte(usageTurns.date, query.to)]),
      ...(query.managerId === undefined ? [] : [eq(usageTurns.managerId, query.managerId)]),
      ...(query.layer === undefined ? [] : [eq(usageTurns.layer, query.layer)]),
      ...(query.site === undefined ? [] : [eq(usageTurns.site, query.site)]),
      ...(query.tokenId === undefined ? [] : [eq(usageTurns.tokenId, query.tokenId)]),
    ];

    const turnRows = await this.#db
      .select()
      .from(usageTurns)
      .where(turnConditions.length === 0 ? undefined : and(...turnConditions))
      .orderBy(
        asc(byteOrder(usageTurns.date)),
        asc(byteOrder(usageTurns.managerId)),
        asc(byteOrder(usageTurns.layer)),
        asc(byteOrder(usageTurns.site)),
        sql`nullif(${usageTurns.tokenId}, '') collate "C" asc nulls last`,
      );

    const unmeteredConditions = [
      ...(query.from === undefined ? [] : [gte(usageUnmetered.date, query.from)]),
      ...(query.to === undefined ? [] : [lte(usageUnmetered.date, query.to)]),
      ...(query.managerId === undefined ? [] : [eq(usageUnmetered.managerId, query.managerId)]),
      ...(query.layer === undefined ? [] : [eq(usageUnmetered.layer, query.layer)]),
      ...(query.site === undefined ? [] : [eq(usageUnmetered.site, query.site)]),
      ...(query.tokenId === undefined ? [] : [eq(usageUnmetered.tokenId, query.tokenId)]),
    ];
    const unmeteredRows = await this.#db
      .select()
      .from(usageUnmetered)
      .where(unmeteredConditions.length === 0 ? undefined : and(...unmeteredConditions))
      .orderBy(
        asc(byteOrder(usageUnmetered.date)),
        asc(byteOrder(usageUnmetered.managerId)),
        asc(byteOrder(usageUnmetered.layer)),
        asc(byteOrder(usageUnmetered.site)),
        asc(byteOrder(usageUnmetered.provider)),
        sql`nullif(${usageUnmetered.tokenId}, '') collate "C" asc nulls last`,
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
    const tokensSince =
      ledger === undefined || ledger.tokensAt === null ? null : toIso(ledger.tokensAt);
    const turnsSince =
      ledger === undefined || ledger.turnsAt === null ? null : toIso(ledger.turnsAt);

    const unreadableRows: UnreadableUsageRow[] = [];
    const readableRows = rows.flatMap((row) => {
      const read = this.#toRow(row);
      if (read === undefined) unreadableRows.push(unreadableUsageRowOf('usage_daily', row));
      return read ?? [];
    });
    const readableTurnRows = turnRows.flatMap((row) => {
      const read = this.#toTurnRow(row);
      if (read === undefined) unreadableRows.push(unreadableUsageRowOf('usage_turns', row));
      return read ?? [];
    });

    const readableUnmeteredRows = unmeteredRows.flatMap((row) => this.#toUnmeteredRow(row) ?? []);

    return {
      rows: readableRows,
      ...(unreadableRows.length === 0 ? {} : { unreadableRows }),
      ...(readableUnmeteredRows.length === 0 ? {} : { unmeteredRows: readableUnmeteredRows }),
      since,
      layersSince,
      tokensSince,
      beforeLedger: isBeforeLedger(since, query.from),
      beforeLayers: isBeforeLayers(layersSince, query.from),
      beforeTokens: isBeforeTokens(tokensSince, query.from),
      turnRows: readableTurnRows,
      turnsSince,
      beforeTurns: isBeforeTurns(turnsSince, query.from),
      notice: USAGE_ESTIMATE_NOTICE,
    };
  }

  async baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null> {
    managerId = stripNul(managerId);
    const rows = await this.#db
      .select()
      .from(usageBaseline)
      .where(and(eq(usageBaseline.layer, layer), eq(usageBaseline.managerId, managerId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toBaseline(row);
  }

  async recordedManagerIds(): Promise<Set<string>> {
    const rows = await this.#db
      .selectDistinct({ managerId: usageDaily.managerId })
      .from(usageDaily);
    return new Set(rows.map((row) => row.managerId));
  }

  // 1つのトランザクションで束ねる: 途中の文が落ちると前の文の DELETE だけが確定し、呼び手が「何も消えていない」と読みうるため。
  async clear(): Promise<{ daily: number; baseline: number; ledger: number; turns: number }> {
    return this.#db.transaction(async (tx) => {
      const daily = await tx.delete(usageDaily).returning({ date: usageDaily.date });
      const baseline = await tx
        .delete(usageBaseline)
        .returning({ managerId: usageBaseline.managerId });
      const ledger = await tx.delete(usageLedger).returning({ id: usageLedger.id });
      const turns = await tx.delete(usageTurns).returning({ date: usageTurns.date });
      await tx.delete(usageUnmetered);
      return {
        daily: daily.length,
        baseline: baseline.length,
        ledger: ledger.length,
        turns: turns.length,
      };
    });
  }

  // `.parse` で投げない: `aggregate()` の集計ごと読めなくなるため。壊れた行は外して跡を残す。
  #toRow(row: typeof usageDaily.$inferSelect): UsageRow | undefined {
    const layer = usageLayerSchema.safeParse(row.layer);
    const site = usageSiteSchema.safeParse(row.site);
    if (!layer.success || !site.success) {
      noteUnreadableUsageRow('usage_daily', row, { layer: !layer.success, site: !site.success });
      return undefined;
    }
    return {
      date: row.date,
      managerId: row.managerId,
      model: row.model,
      layer: layer.data,
      site: site.data,
      // 空文字を外へ出さない: 「id が空文字のトークン」が `byToken` や絞り込みの候補に現れるため。
      ...(row.tokenId === '' ? {} : { tokenId: row.tokenId }),
      totals: {
        inputTokens: toNumber(row.inputTokens),
        outputTokens: toNumber(row.outputTokens),
        cacheReadInputTokens: toNumber(row.cacheReadInputTokens),
        cacheCreationInputTokens: toNumber(row.cacheCreationInputTokens),
        webSearchRequests: toNumber(row.webSearchRequests),
        costUsd: row.costUsd,
        ...unreadableCountsOf(row),
      },
      updatedAt: toIso(row.updatedAt),
    };
  }

  #toTurnRow(row: typeof usageTurns.$inferSelect): UsageTurnRow | undefined {
    const layer = usageLayerSchema.safeParse(row.layer);
    const site = usageSiteSchema.safeParse(row.site);
    if (!layer.success || !site.success) {
      noteUnreadableUsageRow('usage_turns', row, { layer: !layer.success, site: !site.success });
      return undefined;
    }
    return {
      date: row.date,
      managerId: row.managerId,
      layer: layer.data,
      site: site.data,
      ...(row.tokenId === '' ? {} : { tokenId: row.tokenId }),
      turns: toNumber(row.turns),
      updatedAt: toIso(row.updatedAt),
    };
  }

  #toUnmeteredRow(row: typeof usageUnmetered.$inferSelect): UsageUnmeteredRow | undefined {
    const layer = usageLayerSchema.safeParse(row.layer);
    const site = usageSiteSchema.safeParse(row.site);
    if (!layer.success || !site.success) return undefined;
    return {
      date: row.date,
      managerId: row.managerId,
      layer: layer.data,
      site: site.data,
      provider: row.provider,
      ...(row.tokenId === '' ? {} : { tokenId: row.tokenId }),
      turns: toNumber(row.turns),
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
      ...(row.byRunner === null || row.byRunner === undefined
        ? {}
        : { byRunner: row.byRunner as NonNullable<UsageBaseline['byRunner']> }),
    };
  }
}

function unreadableUsageRowOf(
  table: 'usage_daily' | 'usage_turns',
  row: { readonly date: string; readonly layer: string; readonly site: string },
): UnreadableUsageRow {
  const fields = [
    ...(usageLayerSchema.safeParse(row.layer).success ? [] : ['layer']),
    ...(usageSiteSchema.safeParse(row.site).success ? [] : ['site']),
  ];
  return { table, ...(isRealUsageDate(row.date) ? { date: row.date } : {}), fields };
}

// 値を出さない: どの行か（表・`managerId`・`date`）と、どの欄が読めなかったかだけを書く。
function noteUnreadableUsageRow(
  table: 'usage_daily' | 'usage_turns',
  row: { readonly managerId: string; readonly date: string },
  invalid: { readonly layer: boolean; readonly site: boolean },
): void {
  const fields = [invalid.layer ? 'layer' : undefined, invalid.site ? 'site' : undefined]
    .filter((field): field is string => field !== undefined)
    .join(',');
  process.stderr.write(
    `alteroid: 使用量の集計から読めない行を外しました（${table}、managerId=${JSON.stringify(row.managerId)}、date=${JSON.stringify(row.date)}、不正な欄: ${fields}）\n`,
  );
}
