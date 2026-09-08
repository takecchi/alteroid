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
  UsageTurnRow,
} from '@alteroid/core';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso, toNumber } from './db.js';
import { usageBaseline, usageDaily, usageLedger, usageTurns } from './schema.js';

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
 * 照会範囲の一部でも**認証トークンの軸**の始点より前にかかっていたか。
 *
 * 上の2つと同じ形だが、**null で真を返す道がいちばんよく通る。** 層の軸は最初の
 * record で始まるので `layersSince` が null なのは記録が1件も無いときだけだが、
 * トークンの軸は**プールを使っていない器では最後まで始まらない**
 * （`schema.ts` の `usageLedger.tokensAt`）。だからここは「まだ始まっていない」
 * ではなく「この器では取れない」の意味で真になることがある。
 */
function isBeforeTokens(tokensSince: string | null, from: string | undefined): boolean {
  if (tokensSince === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(tokensSince));
}

/**
 * 照会範囲の一部でも**回数の軸**の始点より前にかかっていたか。
 *
 * 上の3つと同じ形。回数の軸は台帳・層の軸と同じ「最初の record」で始まるのが
 * 通常だが、増分が空の record では数えないので、`layersSince` より少し遅れて
 * 始まることがありうる（`turnsSince` の doc）。
 */
function isBeforeTurns(turnsSince: string | null, from: string | undefined): boolean {
  if (turnsSince === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(turnsSince));
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
    tokenId?: string;
  }): Promise<UsageFold> {
    return this.#db.transaction(async (tx) => {
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

      // **「起きた（＝ターン1回）」の判定。** 台帳の行が動いた回（`fold.delta` が
      // 空でない回）だけを1回と数える——増分が空の record（同じ累積スナップショット
      // の再送、失敗した result の再取得など）はターンとして数えない。
      const turned = Object.keys(fold.delta).length > 0;

      // 台帳の開始時刻。**最初の record で1度だけ**入れる（衝突すれば何もしない
      // ＝既にあれば上書きしない）。層の軸の始点は別に持つ — 台帳が先に始まって
      // いる DB では別の時刻になるので、`coalesce` で「まだ無ければ入れる」にする。
      //
      // **トークンの軸は `token_id` が付いた1件目でだけ始まる。** ここを層と
      // 揃えて毎回入れると、プールを1本も持っていない器が「トークン軸を観測
      // している」と名乗る（`schema.ts` の `usageLedger.tokensAt`）。だから
      // 値の側で null を渡し、`coalesce` は「まだ無ければ入れる」のまま使う
      // （null を coalesce しても null なので、始点は動かない）。
      //
      // **回数の軸（`turnsAt`）も同じ形——`turned` のときだけ値を渡す。** ここで
      // `fold` を先に計算する必要があるため、この upsert はかつて`fold` の前に
      // 在ったものを後ろへ動かしてある。**同じトランザクションの中なので観測
      // できる違いは無い**（`fold` が投げればトランザクションごと巻き戻る）。
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
          // **`startedAt` は触らない。** 触ると台帳の始点が毎回いまになる。
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
          // **無いときは空文字。** 列は `not null` なので（null を許すと一意索引が
          // 帰属の無い行を重複と見なさず、record のたびに新しい行が挿さる —
          // `schema.ts` の `usageDaily.tokenId`）。`stripNulls` に undefined を
          // 渡すと列が省かれ、既定の `''` が入る形にもなるが、**書く値を明示する**
          // ほうが「省いたら何が入るか」を読む人が追わなくてよい。
          tokenId: input.tokenId ?? '',
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
              // **トークンも鍵に入れる。** 外すと回した前後の増分が同じ行へ
              // 足し込まれ、`token_id` は先に入った側の値のまま残る — 受け入れ
              // 基準6 が引きたい「どの区間がどのトークンだったか」が、出力から
              // 見分けられない誤帰属に化ける。
              usageDaily.tokenId,
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

      // **「起きた回数」を足し込む。`turned` のときだけ**（0 の行は作らない —
      // `usageTurnRowSchema` の doc）。鍵は `usage_daily` から `model` を抜いた
      // 4軸+トークンで、1ターンにつきちょうど1だけ足す（モデルが何本立っても
      // ここは1のまま——だから `usage_daily` と同じループの中では回さない）。
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
              // **足し込む（上書きではない）。** `usage_daily` の各列と同じ理由。
              turns: sql`${usageTurns.turns} + 1`,
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
      ...(query.tokenId === undefined ? [] : [eq(usageDaily.tokenId, query.tokenId)]),
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
        // **帰属の無い行を最後に置く。`asc(tokenId)` だけでは先頭に来る** —
        // 列は `not null default ''` なので、空文字は昇順のいちばん小さい値である
        // （null なら `asc` の既定が nulls last で最後に来るが、null は使えない
        // ——`schema.ts` の `usageDaily.tokenId`）。だから `nullif` で空文字を
        // null へ戻してから並べる。
        //
        // **fs 側（`@alteroid/storage-fs` の `compareTokenId`）と向きを揃えること。**
        // 器が違うだけで行の並びが変わると、同じ照会が口によって違う順で出る。
        sql`nullif(${usageDaily.tokenId}, '') asc nulls last`,
      );

    // **`usage_daily` と同じ述語で引く。** `UsageQuery` はモデルの絞りを持たない
    // ので、この2つの照会は完全に同じ条件になる（`usageTurns` は `model` 列を
    // そもそも持たない）。
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
        asc(usageTurns.date),
        asc(usageTurns.managerId),
        asc(usageTurns.layer),
        asc(usageTurns.site),
        sql`nullif(${usageTurns.tokenId}, '') asc nulls last`,
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

    return {
      rows: rows.map((row) => this.#toRow(row)),
      since,
      layersSince,
      tokensSince,
      beforeLedger: isBeforeLedger(since, query.from),
      beforeLayers: isBeforeLayers(layersSince, query.from),
      beforeTokens: isBeforeTokens(tokensSince, query.from),
      turnRows: turnRows.map((row) => this.#toTurnRow(row)),
      turnsSince,
      beforeTurns: isBeforeTurns(turnsSince, query.from),
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

  /**
   * `store.ts` の `UsageStore.recordedManagerIds` の doc のとおり、**引数を持たず
   * 全期間から作る。** `where` を持たない `select distinct` なので、`from` / `to`
   * を渡す余地が口の形そのもので無い。
   *
   * **`usage_daily_manager_date_idx`（`schema.ts`）に乗る。** 索引は
   * `(manager_id, date)` の順で、`distinct` が `manager_id` だけを見るこの照会は
   * その先頭列に一致するので、全表走査ではなく索引を使える。
   */
  async recordedManagerIds(): Promise<Set<string>> {
    const rows = await this.#db
      .selectDistinct({ managerId: usageDaily.managerId })
      .from(usageDaily);
    return new Set(rows.map((row) => row.managerId));
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
      // **空文字は `undefined` へ戻す。** 列が `not null` なのは一意索引を成立
      // させるためだけで（`schema.ts` の `usageDaily.tokenId`）、空文字は
      // トークンではない。ここで戻さないと、外へ出す顔に「id が空文字のトークン」
      // が1件現れる（`byToken` に並び、絞り込みの候補にも見える）。
      ...(row.tokenId === '' ? {} : { tokenId: row.tokenId }),
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

  #toTurnRow(row: typeof usageTurns.$inferSelect): UsageTurnRow {
    return {
      date: row.date,
      managerId: row.managerId,
      layer: usageLayerSchema.parse(row.layer),
      site: usageSiteSchema.parse(row.site),
      // **空文字は `undefined` へ戻す。** `usageDaily` の `#toRow` と同じ理由。
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
    };
  }
}
