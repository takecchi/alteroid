import type { JournalEntryType } from '@alteroid/core';
import {
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  JournalAnchorNotFoundError,
  findUnrecordedManagers,
  describeUnreadableJournalTimeBoundary,
  isDailyReport,
  JOURNAL_ENTRY_TYPES,
  journalEntrySchema,
  journalWindowCrossesHorizon,
  localDayRange,
  normalizeJournalTimeBoundary,
  summarizeUsage,
  usageDate,
  usageDateSchema,
  usageLayerSchema,
  usageSiteSchema,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  journalListResponseSchema,
  reportsResponseSchema,
  usageResponseSchema,
} from './openapi.js';
import {
  compareDailyReportsNewestFirst,
  listDailyReports,
  listDailyReportsBefore,
} from './reports.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  INVALID_QUERY_DESCRIPTION,
  jsonResponse,
  errorResponse,
  queryParams,
  readJournalEntry,
} from './app-shared.js';

// 可視の複合キー（`beforeDate` / `beforeAt`）でページングし、不透明な `cursor` を使わない: 応答に新しい欄を足さずに済む。封筒（`total` / `nextCursor`）を持たない: 続きが在るかは `limit` 件ちょうど返ったかで判る。`order` は足さない（常に日付の新しい順）。
const reportsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).default(7),
  beforeDate: z.string().optional(),
  beforeAt: z.string().optional(),
});

// 可視の複合キーでページングし、不透明な `cursor` を使わない。`/reports` の `before*` と違い `after*` なのは揃え忘れではない: `order=asc` のとき `before` は嘘になるので、方向に縛られない語（返る順序における次）を使う。
// `afterId` と `afterAt` は必ず組で渡す: `afterAt` 単独では同じミリ秒の同着を割れず、`afterId` 単独では fs 実装が `at` からファイルを決める都合で実装によって答えが変わりうる。
const journalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  // ISO 8601。ここより古いエントリまで遡って読むための足がかり。形は縛らない: `Date.parse` が読める形（秒の省略・オフセット付きなど）をそのまま受けたいので、検査と正規化はハンドラの中で行う。
  since: z.string().optional(),
  // `since` だけでは過去の一区間を取れない: 新しい順に返すので、最新のものが `limit` を食い尽くす。
  until: z.string().optional(),
  // カンマ区切りで複数。知らない値は 400 で断る（ハンドラで検査）: 黙って無視すると、綴りを間違えた呼びが「0件」として返り、「起きていない」と読み違える。スキーマを `z.enum` にしないのは、未知のキーを拒まない方針と同じく検査をハンドラに寄せて、有効値の案内を error に載せるため。
  type: z.string().optional(),
  // `q=`（空文字列）は絞らない: 検索欄を空にした呼びが 0 件を返すと「消えた」と読まれるので `.min(1)` を掛けない。画面のために別の口を足さない。
  q: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  afterId: z.string().optional(),
  afterAt: z.string().optional(),
  // `z.coerce.boolean()` を使わない: `?horizon=false` が true になってしまう。既定は付けない（`.optional()`）: 渡さない呼びの応答を1バイトも変えない。
  horizon: z.enum(['true', 'false']).optional(),
});

// 既定で期間を絞らない: 絞ると「今日いくら使ったか」を聞いたつもりの人へ全期間の合計を返す取り違えが起きる。
const usageQuery = z.object({
  from: usageDateSchema.optional(),
  to: usageDateSchema.optional(),
  managerId: z.string().min(1).optional(),
  // 4つの口（API / CLI / Web / クローンの道具）へ同時に置く: 片方にだけ足すと、そこにしかできない分析が生まれる。
  layer: usageLayerSchema.optional(),
  site: usageSiteSchema.optional(),
  // 「帰属が無い分だけ」を絞る口は作らない（`usage.ts` の `usageQuerySchema`）: 取れていない分は絞らずに引いて `breakdown.byToken` の `null` を見る。
  tokenId: z.string().min(1).optional(),
});

export function journalRoutes(ctx: AppContext, deps: AppDeps) {
  const { clone, stores, clock } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      .get(
        '/journal',
        describeRoute({
          tags: ['journal'],
          summary: '日誌を読む',
          description:
            '日誌（追記専用の記録）を読む。`type` `since` `until` で掘れる。' +
            '`type` はカンマ区切りで複数を渡せ、**知らない値は 400**（綴り違いを黙って0件にしない。' +
            '使える値は 400 の `error` に載る）。' +
            '**`with`（exchange の相手での絞り込み）はこの口に無い** —— 渡しても無視されて絞られない' +
            '（未知のキーは拒まない）。相手で絞るには `journal_read` の `with` を使う。' +
            '`q` で本文を語で探せる（大文字小文字を区別しない部分一致。他の絞りと併用できる）。' +
            '**`q` が当たらないことは「日誌にその語が無い」を意味しない** —— ' +
            `${JOURNAL_SEARCH_UNCOVERED_LIST_MD} は探す対象に入っていない。` +
            '`q=`（空）は絞らない。' +
            '既定は新しい順（`order:desc`）——`order:asc` で古い順にもできる。' +
            '`afterId` と `afterAt` を両方渡すと、前の頁の最後の行より後ろ' +
            '（＝返る順序における次）を返す（可視の複合キー。応答に `id`/`at` が' +
            '既に載っているのでそこから組み立てる）。**`after` は返る順序の意味で' +
            'あって時間の意味ではない** —— `order:desc`（既定）では、指した行より' +
            '**古い**行が返る。`order:asc` ではその逆（**新しい**行が返る）。' +
            '**封筒は持たない** —— 続きが在るかは `limit` 件ちょうど返ったかで判る。' +
            '`since`/`until` のどちらかを指定すると、応答に `oldestAt`（日誌の地平。' +
            '日誌が空なら `null`）と `crossesHorizon`（窓の始点が地平より前に' +
            'かかるか）を足す——真なら「その窓には無かった」のか「日誌がそこまで' +
            '遡れないだけ」なのかを、この応答だけからは区別できない。' +
            '`since`/`until` を省略した呼びでも、`horizon=true` を渡せば同じ2欄が' +
            '付く（issue #1530）——窓は絞らないまま、地平の情報だけを明示に求める口。' +
            '`horizon` を渡さない呼びの応答は1バイトも変わらない。',
          responses: {
            200: jsonResponse(
              '日誌エントリの一覧。`since`/`until` のどちらかを指定した呼び、' +
                'または `horizon=true` を渡した呼びには `oldestAt`/`crossesHorizon` ' +
                'が付く（どちらも渡さない呼びには付かない）。' +
                '`next` は次の頁の継続点（`afterId` / `afterAt` へそのまま渡せる）で、' +
                '`null` のときだけ本当の終端。`entries` が `limit` 未満でも空でも、' +
                '`null` でなければ先に行が在る（読めない行は `limit` の後で捨てられる）。',
              journalListResponseSchema,
            ),
            400: errorResponse(
              'クエリが不正、`type` に知らない値が入っている、または `since` / `until` が日時として読めない・' +
                '`afterId` / `afterAt` の片方だけが渡された・' +
                '`afterAt` の形式が不正、または `afterId`/`afterAt` が指す行が見当たらない。',
            ),
          },
        }),
        queryParams(journalQuery),
        async (c) => {
          const { limit, since, until, type, q, order, afterId, afterAt, horizon } =
            c.req.valid('query');
          const requestedTypes = type?.split(',').filter((value) => value.length > 0);
          const unknownTypes = (requestedTypes ?? []).filter(
            (value) => !(JOURNAL_ENTRY_TYPES as readonly string[]).includes(value),
          );
          if (unknownTypes.length > 0) {
            return c.json(
              {
                error:
                  `type に知らない値が入っている: ${unknownTypes.join(', ')}` +
                  `（使えるのは ${JOURNAL_ENTRY_TYPES.join(' / ')}。カンマ区切りで複数）`,
              },
              400,
            );
          }
          const types = requestedTypes as JournalEntryType[] | undefined;

          // 片方だけでは境界が決まらない。この2つの if で TypeScript が `afterId`/`afterAt` を以降 `string` に絞る。
          if (afterId === undefined && afterAt !== undefined) {
            return c.json({ error: 'afterId と afterAt は両方一緒に渡す' as const }, 400);
          }
          if (afterId !== undefined && afterAt === undefined) {
            return c.json({ error: 'afterId と afterAt は両方一緒に渡す' as const }, 400);
          }
          if (afterId !== undefined && afterAt !== undefined && Number.isNaN(Date.parse(afterAt))) {
            return c.json({ error: 'afterAt は ISO 8601 で指定する' as const }, 400);
          }

          // `toISOString()` へ正規化してからストアへ渡す: pg は時刻で比べるが fs・インメモリは文字列比較なので、秒の省略やオフセットで3実装の答えが割れる。
          if (since !== undefined && normalizeJournalTimeBoundary(since) === null) {
            return c.json({ error: describeUnreadableJournalTimeBoundary('since', since) }, 400);
          }
          if (until !== undefined && normalizeJournalTimeBoundary(until) === null) {
            return c.json({ error: describeUnreadableJournalTimeBoundary('until', until) }, 400);
          }
          const normalizedSince =
            since === undefined ? undefined : normalizeJournalTimeBoundary(since)!;
          const normalizedUntil =
            until === undefined ? undefined : normalizeJournalTimeBoundary(until)!;

          try {
            const { entries, next } = await stores.journal.listPage({
              limit,
              order,
              ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
              ...(normalizedUntil === undefined ? {} : { until: normalizedUntil }),
              ...(types === undefined || types.length === 0 ? {} : { types }),
              ...(q === undefined ? {} : { q }),
              ...(afterId === undefined || afterAt === undefined
                ? {}
                : { after: { id: afterId, at: afterAt } }),
            });

            // 0件かどうかでは決めない: 窓がまるごと地平より後ろなら、0件でも「本当に無かった」と言い切れる。
            const oldestAt =
              normalizedSince !== undefined || normalizedUntil !== undefined || horizon === 'true'
                ? await stores.journal.oldestAt()
                : undefined;
            // `journal_read` と同じ関数（`journalWindowCrossesHorizon`）を呼ぶ: 2箇所に書き写さない。
            const crossesHorizon =
              oldestAt === undefined
                ? undefined
                : journalWindowCrossesHorizon(oldestAt, normalizedSince);

            return c.json({
              entries,
              // `entries` が `limit` 未満・空でも、`null` でない限り先に行が在る: ストアは読めない行を `limit` の後で捨てる。
              next,
              ...(oldestAt === undefined ? {} : { oldestAt }),
              ...(crossesHorizon === undefined ? {} : { crossesHorizon }),
            });
          } catch (error) {
            // 指す行が見当たらないのは判定できないという第3の状態: 黙って先頭から返さず 400 にする。
            if (error instanceof JournalAnchorNotFoundError) {
              return c.json({ error: error.message }, 400);
            }
            throw error;
          }
        },
      )

      // `GET /journal/stream` より後ろに登録する: 先だと `stream` が id として読まれる。在るが読めない行は 409（「無い」と言わない）。
      .get(
        '/journal/:id',
        describeRoute({
          tags: ['journal'],
          summary: '日誌を id で1件読む',
          description:
            '日誌の1件を全文で返す（`GET /journal` の `entries` の1行と同じ形。封筒は持たない）。' +
            '一覧の窓の外の記録もここで引ける。',
          responses: {
            200: jsonResponse('日誌エントリ1件。', journalEntrySchema),
            404: errorResponse('該当する日誌が無い。'),
            409: errorResponse(
              '日誌の行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
            ),
          },
        }),
        async (c) => {
          const read = await readJournalEntry(stores, c.req.param('id'));
          if (read.kind === 'unreadable') return c.json({ error: read.message }, 409);
          const entry = read.value;
          if (entry === null) return c.json({ error: 'not found' as const }, 404);
          return c.json(journalEntrySchema.parse(entry));
        },
      )

      // 経路は1本だけにする: 画面のために別の口を足すと、その瞬間に「CLI ではできないこと」が生まれる。
      .get(
        '/usage',
        describeRoute({
          tags: ['usage'],
          summary: '利用状況（alteroid が使った分）',
          description:
            'SDK の `result.modelUsage` を積んだ台帳を、日 × マネージャー × モデルで返す。' +
            '**推定値であり請求明細ではない**（`notice` に同じ但し書きが載る）。' +
            '台帳の始点は `since`、照会範囲が始点より前にかかっていれば `beforeLedger` が真になる — ' +
            'そのときは 0 ではなく「記録が無い」と読むこと（過去分の掘り起こしはしていない）。' +
            '層と場所の軸は台帳より後から入ったので、始点は `layersSince`、' +
            '照会範囲がそれより前にかかっていれば `beforeLayers` が真になる — ' +
            'そのときの `layer` / `site` は既定値であって観測ではない。' +
            '認証トークンの軸も同じ形で `tokensSince` / `beforeTokens` を返すが、' +
            '**null の意味が1つ多い** — 記録が1件も無いときだけでなく、' +
            '**プールを使っていない構成では最後まで null である**（`since` が非 null でも起きる）。' +
            'そのときの `breakdown.byToken` は `tokenId: null` の1件だけを返す。' +
            'それは「1本のトークンで全部使った」ではなく「帰属が取れていない」である。' +
            '`unrecordedManagers` は消費の記録が1件も無い委譲（Issue #98）——' +
            '`from` / `to` などの絞り込みには影響されない（全期間で判定する）。' +
            '`resets` は累積の数え直し（resume / `/clear` などで SDK 側の累積が 0 から始まったとみなした回数）を、' +
            '層 × マネージャーの基準ごとに返す（`resets` は回数、`lastResetAt` は最後の時刻で、0 回なら無い）。' +
            '基準が1件も無いときは欄ごと無い。**日付に依らない現在値**で、`from` / `to` / `site` / `tokenId` では絞らず、' +
            '`layer` / `managerId` だけで絞る。判定は推定で、誤って数え直しとみなす・拾えない、のどちらもありうる' +
            '（回数が増え続けていないかを見張る口）。',
          responses: {
            200: jsonResponse('台帳の集計。', usageResponseSchema),
            400: errorResponse(INVALID_QUERY_DESCRIPTION),
          },
        }),
        queryParams(usageQuery),
        async (c) => {
          const { from, to, managerId, layer, site, tokenId } = c.req.valid('query');
          const aggregate = await stores.usage.aggregate({
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(managerId === undefined ? {} : { managerId }),
            ...(layer === undefined ? {} : { layer }),
            ...(site === undefined ? {} : { site }),
            ...(tokenId === undefined ? {} : { tokenId }),
          });
          // 全期間・絞り込み無しの2つを突き合わせる: クエリで狭めた `aggregate.rows` から作ると、照会範囲の外で記録された委譲が「記録が無い」に化ける。
          const allManagers = await clone.managers.list();
          const recordedManagerIds = await stores.usage.recordedManagerIds();
          const unrecordedManagers = findUnrecordedManagers(
            allManagers,
            recordedManagerIds,
            aggregate.since,
          );
          return c.json({
            ...aggregate,
            // 内訳は core の1つの実装で作る（口ごとに足し直すと食い違う）。
            breakdown: summarizeUsage(aggregate.rows, aggregate.turnRows),
            // 配線されていなければ「まだ分からない」を返す: 0 や null にすると「枠を使っていない」と読める。
            account: deps.accountUsage?.() ?? { state: 'unknown' as const },
            unrecordedManagers,
            // 台帳の `date` を書くのと同じ関数・同じ TZ で評価する: ブラウザの TZ で「今日」を決めると台帳の日とずれる。
            today: usageDate(clock()),
          });
        },
      )

      .get(
        '/reports',
        describeRoute({
          tags: ['reports'],
          summary: '日報の一覧',
          description:
            '日報（可観測性の最上段）を**日付の新しい順**に読む（同じ日に複数あれば書いた時刻の新しい方が先）。' +
            '日誌の並び（書いた順）とは一致しない — 遡り生成では前の日ぶんの日報が今日書かれる（`reports.ts`）。' +
            '`beforeDate` と `beforeAt` を両方渡すと、前の頁の最後の日報より後ろ' +
            '（＝より古い側）を返す（可視の複合キー。応答に `date`/`at` が既に載っている' +
            'のでそこから組み立てる）。**封筒は持たない** — 続きが在るかは `limit` 件' +
            'ちょうど返ったかで判る。',
          responses: {
            200: jsonResponse('日報の一覧（日付の新しい順）。', reportsResponseSchema),
            400: errorResponse(
              'クエリが不正、または `beforeDate` / `beforeAt` の片方だけが渡された・形式が不正。',
            ),
          },
        }),
        queryParams(reportsQuery),
        async (c) => {
          const { limit, beforeDate, beforeAt } = c.req.valid('query');

          // 並べ直しはここが持つ: 画面や CLI の側で並べ直すと「最新の日報」が口ごとに食い違う。
          if (beforeDate === undefined && beforeAt === undefined) {
            const reports = await listDailyReports(stores.journal, limit);
            return c.json({ reports });
          }

          // 片方だけでは境界が決まらない: `beforeAt` 単独では日付順の主キーが埋まらず、`beforeDate` 単独では同じ日の複数（締めと遡り生成）を切れない。この if で TypeScript が以降 `string` に絞る。
          if (beforeDate === undefined || beforeAt === undefined) {
            return c.json(
              { error: 'beforeDate と beforeAt は両方一緒に渡す（片方だけでは境界が決まらない）' },
              400,
            );
          }

          // 現物のカレンダー妥当性まで見る: 2月30日のような日を通さない。
          if (localDayRange(beforeDate) === null) {
            return c.json({ error: 'beforeDate は YYYY-MM-DD で指定する' }, 400);
          }
          if (Number.isNaN(Date.parse(beforeAt))) {
            return c.json({ error: 'beforeAt は ISO 8601 で指定する' }, 400);
          }

          // 日報が実在することは要求しない: 境界は比較で決まるので、指していた日報が見当たらなくても続きは正しく定まる。
          const reports = await listDailyReportsBefore(stores.journal, limit, {
            date: beforeDate,
            at: beforeAt,
          });
          return c.json({ reports });
        },
      )

      .get(
        '/reports/:date',
        describeRoute({
          tags: ['reports'],
          summary: '1日分の日報',
          responses: {
            200: jsonResponse('その日の日報。', reportsResponseSchema),
            400: errorResponse('日付が `YYYY-MM-DD` 形式ではない（黙って別の日にずらさない）。'),
            404: errorResponse('その日の日報が無い。'),
          },
        }),
        async (c) => {
          const date = c.req.param('date');
          const range = localDayRange(date);
          if (range === null)
            return c.json({ error: '日付は YYYY-MM-DD で指定する' as const }, 400);

          const entries = await stores.journal.list({
            types: ['daily_report'],
            since: range.since.toISOString(),
          });
          // 一覧（`/reports`）と同じ比較で並べる: 画面は「その日の先頭」を既定で開くので、口ごとに違うと開くものが変わる。
          const reports = entries
            .filter(isDailyReport)
            .filter((entry) => entry.date === date)
            .sort(compareDailyReportsNewestFirst);
          if (reports.length === 0) return c.json({ error: 'not found' as const }, 404);
          return c.json({ reports });
        },
      )
  );
}
