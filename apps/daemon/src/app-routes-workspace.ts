import {
  ARCHIVE_REMOVED_BYTES_UNIT_NOTE,
  droppedTraceLedgerSince,
  isOffsetQualifiedTimeBoundary,
  describeOffsetRequiredTimeBoundary,
  guardArchiveRemoval,
  INBOX_EVENT_TYPE_ORDER,
  matchesInboxRemoveManyFilter,
  removeArchiveJournalFirst,
  removeInboxChunkJournalFirst,
  summarizeInboxBacklog,
  noteDroppedRecord,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
  chunkIdsByChars,
  REMOVE_MANY_JOURNAL_ID_CHARS,
  REMOVE_MANY_LIMIT_DEFAULT,
  REMOVE_MANY_LIMIT_MAX,
  readProgress,
  DEFAULT_PROGRESS_WINDOW_HOURS,
  InvalidProgressWindowError,
  PROGRESS_WINDOW_HOURS_INVALID_MESSAGE,
  type InboxRemoveManyFilter,
} from '@alteroid/core';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  archiveListResponseSchema,
  archiveRemovedResponseSchema,
  archiveRemoveResponseSchema,
  archiveSessionsResponseSchema,
  progressResponseSchema,
  droppedResponseSchema,
  inboxBacklogResponseSchema,
  inboxRemoveManyRequestSchema,
  inboxRemoveManyResponseSchema,
  inboxRemoveManyStoppedResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import {
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  jsonBody,
  queryParams,
  journalWriteFailedBody,
  kindOfError,
} from './app-shared.js';

// 空文字を弾かない: `guardArchiveRemoval` が `reason?.trim()` の非空を override の意思表示として扱うので、ここで `min(1)` を掛けると同じ入力が契約より手前で別の応答（400）になる。
const archiveRemoveQuery = z.object({
  overrideReason: z.string().optional(),
});

// 文字列のまま受ける: `z.coerce.number()` だと空文字が 0 になり、「渡していない」「空を渡した」「0 を渡した」が区別できない。
const progressQuery = z.object({
  windowHours: z.string().optional(),
});

export function workspaceRoutes(ctx: AppContext) {
  const { clone, stores } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      .get(
        '/archive',
        describeRoute({
          tags: ['archive'],
          summary: 'アーカイブ済みセッション生ログの一覧',
          description:
            'セッション生ログ（可観測性の最下段）の一覧（#698）。id だけでなく ' +
            'sessionId・時刻・実使用バイト数（storedBytes）を返す——大きさや時刻を ' +
            '知るために本文（GET /archive/:id）を全文落とす必要が無い。',
          responses: {
            200: jsonResponse('アーカイブの一覧。新しい順。', archiveListResponseSchema),
          },
        }),
        async (c) =>
          c.json(archiveListResponseSchema.parse({ entries: await stores.archive.list() })),
      )

      // `:id` より前に置く: 後ろだと `sessions` が `:id` に食われてこの経路へ一生届かない（hono は登録順で最初に一致した経路を使う）。
      .get(
        '/archive/sessions',
        describeRoute({
          tags: ['archive'],
          summary: 'アーカイブ済みセッション生ログの sessionId ごとの集計',
          description:
            'sessionId ごとの行数（rows）・実使用バイト数の合計/最大・最初/最後の ' +
            '時刻（#698）。rows は tombstone 済みの行も数える——「同じセッションの ' +
            '生ログが何度も積まれている」という重複を見つけるための経路。',
          responses: {
            200: jsonResponse('sessionId ごとの集計の一覧。', archiveSessionsResponseSchema),
          },
        }),
        async (c) =>
          c.json(
            archiveSessionsResponseSchema.parse({ sessions: await stores.archive.sessions() }),
          ),
      )

      .get(
        '/archive/:id',
        describeRoute({
          tags: ['archive'],
          summary: 'アーカイブ済み生ログを1件読む',
          responses: {
            200: {
              description: '生ログ（JSONL の生テキスト）。',
              content: { 'text/plain': { schema: resolver(z.string()) } },
            },
            404: errorResponse('該当するアーカイブが無い。'),
            410: jsonResponse(
              '本文は `DELETE /archive/:id` で消されている（#698）。行そのものは残る——' +
                'この id は `/archive` の一覧には引き続き出る。いつ・何バイト落としたかを返す。',
              archiveRemovedResponseSchema,
            ),
          },
        }),
        async (c) => {
          const result = await stores.archive.read(c.req.param('id'));
          if (result.kind === 'missing') return c.json({ error: 'not found' as const }, 404);
          if (result.kind === 'removed') {
            return c.json(
              archiveRemovedResponseSchema.parse({
                error: 'removed',
                removedAt: result.removedAt,
                bytes: result.bytes,
              }),
              410,
            );
          }
          return c.text(result.body);
        },
      )

      // 走行中のマネージャーの退避の判定は `guardArchiveRemoval`（`ManagerPool.runningManagerOwning()`）1箇所だけを通す: クローンの道具 `archive_remove` と同じ関数で、2箇所に書くと片方だけ直る形になる。
      .delete(
        '/archive/:id',
        describeRoute({
          tags: ['archive'],
          summary: 'アーカイブ済み生ログの本文を消す（行は残る）',
          description:
            '本文だけを落とす（tombstone）。行そのものは消えない——`/archive` の一覧には' +
            '引き続き出る。存在しない id を渡しても成功にはならない。走行中のマネージャーの' +
            '退避は既定では消せない（拒む。どのマネージャーが走行中かを言う）。' +
            'クエリ引数 `overrideReason` にその理由を書けば通せる' +
            '（north_star 禁止2「方針は設定で開けられなければならない」の実装——' +
            '既定拒否は能力の一律な削除ではなく方針である）。override したときは' +
            '理由と対象のマネージャー id を日誌に残す。',
          responses: {
            200: jsonResponse('消した（または前から消されていた）。', archiveRemoveResponseSchema),
            400: errorResponse(
              'クエリ引数 `overrideReason` の形が不正（`queryParams` の hook が断る。' +
                'PR #1747 が揃えた形——送られた値は1文字も含めない）。',
            ),
            404: errorResponse('該当するアーカイブが無い。'),
            409: errorResponse(
              '走行中のマネージャーの退避なので消せない。`overrideReason` クエリ引数で開ける。',
            ),
            500: journalWriteFailedResponse(
              '消す前の日誌が書けなかったので消していない（`code` は `journal_write_failed`。本文は戻せないので、日誌を先に書く）。',
            ),
          },
        }),
        queryParams(archiveRemoveQuery),
        async (c) => {
          const id = c.req.param('id');
          const { overrideReason } = c.req.valid('query');
          const guard = guardArchiveRemoval(clone.managers, id, overrideReason);
          if (guard.kind === 'denied') {
            return c.json(
              {
                error:
                  `走行中のマネージャー ${guard.managerId} の退避なので消せない` +
                  '（overrideReason クエリ引数に理由を書けば通せる）',
              },
              409,
            );
          }
          // 本文は消すと戻らないので、日誌を先に書いてから消す（`removeArchiveJournalFirst`）。書けなければ消さずに 500。
          // 消す対象・override の理由は消す前に決まるので先の行に書く。バイト数と「前から消されていたか」は消した後でないと分からないので、2行目として足す（落ちても握る）。
          const overrideNote =
            guard.kind === 'allowed-with-override'
              ? `（⚠️ override — 走行中のマネージャー ${guard.managerId} の退避だが、` +
                `理由「${guard.reason}」により消す）`
              : '';
          const grounds =
            guard.kind === 'allowed-with-override'
              ? `人間が API から直接操作した（override理由: ${guard.reason}）`
              : '人間が API から直接操作した';
          const result = await removeArchiveJournalFirst(stores, id, {
            buildEntry: () => ({
              type: 'decision',
              decision: `退避済み生ログの本文を消す: ${id}${overrideNote}`,
              grounds,
            }),
            buildAfterEntry: (done) => ({
              type: 'decision',
              decision:
                `退避済み生ログの本文を消した結果: ${id}（${done.bytes} バイト。${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}。` +
                `${done.kind === 'already' ? '前から消されていたので今回は何も変わっていない' : 'いま消した'}）`,
              grounds,
            }),
          });
          if (result.kind === 'journal-failed') {
            noteDroppedRecord(
              'アーカイブ本文削除の日誌（消していない）',
              `id=${id}`,
              kindOfError(result.error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          if (result.kind === 'missing') return c.json({ error: 'not found' as const }, 404);
          return c.json(
            archiveRemoveResponseSchema.parse({
              ok: true,
              id,
              bytes: result.bytes,
              alreadyRemoved: result.kind === 'already',
              ...(guard.kind === 'allowed-with-override'
                ? { override: { managerId: guard.managerId, reason: guard.reason } }
                : {}),
            }),
          );
        },
      )

      // クローン自身の道具（`inbox_remove_many`）はまだ無い: 自分の受信箱を自分で捨てられることの是非があるため保留中で、ここへ道具を足す実装者は別 PR（draft・`[保留]`）の判断（takecchi）を待つこと。絞り込みの判定（`matchesInboxRemoveManyFilter`）は SQL 側に複製しない。「全部消すを1回で撃てる形は作らない」: 事故で受信箱を1回で空にできる形を作らない。
      .post(
        '/inbox/remove',
        describeRoute({
          tags: ['inbox'],
          summary: '受信箱の未読を、絞り込みを渡してまとめて畳む（消す）',
          description:
            '人間の入口から、受信箱の未読を絞り込んでまとめて消す（issue #972）。' +
            '同じ失敗の写しが数千件積もると、クローン側は1ターン1件のペースでしか' +
            '排出できず、排出それ自体が文脈窓を食い潰す——人間はこの口から直接' +
            'まとめて消せる。**既定は試算（`dryRun` を省略すると true）で、1件も' +
            '消さない。** ' +
            `\`types\` は必須で、在る7種類（${INBOX_EVENT_TYPE_ORDER.join(' / ')}）を` +
            '全部並べた呼びは断る（「全部消す」を1回で撃てる形は作らない——それは' +
            '`POST /reset`（記憶ごと全部消す）の役目である）。行は台帳の close とは' +
            '違い**物理的に消える**——`InboxStore` は「まだ処理し終えていない」という' +
            '事実だけを持つ器で、片付いた後の記録を残す場所ではない。' +
            '**消す id は塊ごとに、消す前に日誌へ残す**（書けなかったらその塊は消さずに止める）。',
          responses: {
            200: jsonResponse('試算、または実際に消した結果。', inboxRemoveManyResponseSchema),
            500: jsonResponse(
              '塊の先の日誌が書けなかったので、その塊とそれ以降を消さずに止めた（`code` は `journal_write_failed`）。' +
                '止める前の塊は消えている——`removedIds` / `droppedFromDelivery` がどこまでかを言う。',
              inboxRemoveManyStoppedResponseSchema,
            ),
            400: errorResponse(
              '本文が不正、または `types` が在る7種類を全部並べている（絞り込みが無いのと同じ）、' +
                'または `before` が ISO8601 として読めない。',
            ),
          },
        }),
        jsonBody(inboxRemoveManyRequestSchema),
        async (c) => {
          const { types, sources, before, reason, dryRun, limit } = c.req.valid('json');

          // 絞り込みの無い呼びを断る。
          if (INBOX_EVENT_TYPE_ORDER.every((known) => types.includes(known))) {
            return c.json(
              {
                error:
                  `types に在る7種類（${INBOX_EVENT_TYPE_ORDER.join(', ')}）を全部並べた呼びは` +
                  '断る——それは絞り込みが無いのと同じで、1回で受信箱を空にできてしまう。' +
                  '消したい種類だけを名指しすること（例 types: ["manager_message"]）。' +
                  '**1件も消していない。**',
              },
              400,
            );
          }
          if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
            // 存在しない日付・日付でない文字列を別の時刻として読んで消さず、時差の無い時刻をデーモンの地方時刻として読んで消さない: 元に戻せない一括削除なので時差を必須にする（道具 `inbox_remove_many` と同じ門・同じ文言）。
            return c.json(
              {
                error:
                  describeOffsetRequiredTimeBoundary(
                    'before',
                    before,
                    '2026-10-06T09:00:00+09:00',
                  ) + '**1件も消していない。**',
              },
              400,
            );
          }
          if (limit !== undefined && limit > REMOVE_MANY_LIMIT_MAX) {
            return c.json(
              { error: `limit は ${REMOVE_MANY_LIMIT_MAX} 件までである。**1件も消していない。**` },
              400,
            );
          }

          const filter: InboxRemoveManyFilter = {
            types,
            ...(sources === undefined ? {} : { sources }),
            ...(before === undefined ? {} : { before }),
          };
          // 絞りはここで当てる: SQL 側に同じ判定を複製しない（`matchesInboxRemoveManyFilter`）。
          const allPending = (await stores.inbox.peekPending()).entries;
          const matched = allPending.filter((row) => matchesInboxRemoveManyFilter(row, filter));

          const effectiveLimit = limit ?? REMOVE_MANY_LIMIT_DEFAULT;
          const targets = matched.slice(0, effectiveLimit);
          const remaining = matched.length - targets.length;

          if (dryRun !== false) {
            return c.json(
              inboxRemoveManyResponseSchema.parse({
                ok: true,
                dryRun: true,
                totalPending: allPending.length,
                matched: matched.length,
                targeted: targets.length,
                removedIds: targets.map((row) => row.event.id),
                droppedFromDelivery: 0,
                remaining,
              }),
            );
          }

          // 塊ごとに「その塊の id を日誌へ書く → 消す」を交互に回す（`removeInboxChunkJournalFirst`）: 消すと配達も止まるので、消してから書くと日誌が落ちた回に何を畳んだかが残らない（消えた合図は戻らない）。
          // 塊の先の行が書けなければ、その塊は消さずにそこで止める（後ろの塊も消さない）。止める前の塊は消えているので、どこまで消したかを 500 の本文で返す。
          // `stores.inbox.removeMany` を直に呼ばない: 器から消すのと配達を止めるのを1つの呼びで行うクローンの道具と同じ関数を通す（helper の中）。2箇所に割れたまま残すと片方だけ直っている形が再生産される。
          const chunks = chunkIdsByChars(
            targets.map((row) => row.event.id),
            REMOVE_MANY_JOURNAL_ID_CHARS,
          );
          const filterText = [
            `types=[${types.join(', ')}]`,
            ...(sources === undefined ? [] : [`sources=[${sources.join(', ')}]（完全一致）`]),
            ...(before === undefined ? [] : [`before=${before}`]),
          ].join(' / ');
          const removedIds: string[] = [];
          let droppedFromDelivery = 0;
          for (const [index, chunk] of chunks.entries()) {
            const outcome = await removeInboxChunkJournalFirst(stores, clone, chunk, () => ({
              type: 'decision',
              decision:
                `人間が受信箱の未読を絞り込みで一括して畳む（消す）` +
                `（${index + 1}/${chunks.length} 塊目、この塊は ${chunk.length} 件）: ${reason}\n` +
                `絞り込み: ${filterText}\n` +
                `消す id: ${chunk.join(' ')}`,
              grounds: '人間が直接 API から操作した',
            }));
            if (outcome.kind === 'journal-failed') {
              noteDroppedRecord(
                '受信箱一括削除の日誌（この塊は消していない）',
                `chunk=${index + 1}/${chunks.length} count=${chunk.length}`,
                kindOfError(outcome.error),
              );
              return c.json(
                inboxRemoveManyStoppedResponseSchema.parse({
                  ...journalWriteFailedBody(),
                  removedIds,
                  droppedFromDelivery,
                }),
                500,
              );
            }
            droppedFromDelivery += outcome.droppedFromDelivery;
            removedIds.push(...outcome.removedIds);
          }

          return c.json(
            inboxRemoveManyResponseSchema.parse({
              ok: true,
              dryRun: false,
              totalPending: allPending.length,
              matched: matched.length,
              targeted: targets.length,
              removedIds,
              droppedFromDelivery,
              remaining,
            }),
          );
        },
      )

      // `claimPending()` ではなく `peekPending()` を使う: `claimPending()` は呼ぶだけで未読の全行の `deliveries`（器の入れ替え回数）を進めるので、ただ読むだけの口が「器が入れ替わった」という嘘の回数を増やしてはならない。集計は `summarizeInboxBacklog` をそのまま呼び複製しない: クローンの `manager_list` とこの口が別々の集計を持つと数が食い違う。上限（bySource の上位5件）も同じ関数から継承する。
      .get(
        '/inbox',
        describeRoute({
          tags: ['inbox'],
          summary: '受信箱の滞留の内訳を読む',
          description:
            'クローンの道具 `manager_list` の中にしか出ていなかった内訳' +
            '（`summarizeInboxBacklog` の結果）を、人間の入口（HTTP）から読む' +
            '（issue #783 段0）。`claimPending()` ではなく `peekPending()` を使うので、' +
            '呼んでも `deliveries`（器の入れ替え回数）は1つも進まない。集計は' +
            '`@alteroid/core` の同じ関数を通すので、クローンの道具と違う数を返すことは無い。',
          responses: {
            200: jsonResponse(
              '受信箱の内訳。0件のときは `oldestAt` 等、実際には取れていない欄を省く' +
                '（値を作らない。`InboxStore.pending` と同じ作法）。読めない行が1件でも在るときだけ' +
                '`unreadable`（id・受信時刻・不正な欄名。本文は載せない）が載る。`total` は読めた行の数で、' +
                '読めない行は入っていない。**`total: 0` で `unreadable` が無いときだけ「未処理の合図は無い」。**',
              inboxBacklogResponseSchema,
            ),
          },
        }),
        async (c) => {
          const peek = await stores.inbox.peekPending();
          return c.json(
            inboxBacklogResponseSchema.parse(
              summarizeInboxBacklog(peek.entries, Date.now(), peek.unreadable),
            ),
          );
        },
      )

      // `limit` のクエリ引数は無い: 帳面自体が `RECENT_TRACE_LIMIT` で上限を持つので、HTTP の口はいつも全件を返す（人間はブラウザで扱えるので締めると能力が落ちる。予算を持つのはエージェント向けの `self_dropped` だけ）。跡が0件でも 200 を返し、404 やエラーにしない: 「握り潰しが1件も無かった」わけではなく、プロセスの生存中だけの記憶で再起動で消える。
      .get(
        '/dropped',
        describeRoute({
          tags: ['dropped'],
          summary: '握り潰しの跡を読む',
          description:
            'デーモンのプロセス（クローンを含む）が残した跡だけを返す。別プロセスの ' +
            'runner が残した跡はここには出ない。跡が0件でも 200 を返す — 0件は ' +
            '「握り潰しが1件も無かった」ことを意味しない（プロセスの生存中だけの ' +
            '記憶で、再起動・デプロイの入れ替えで消える）。`limit` のクエリ引数は ' +
            '無い（帳面自体が `limit` 件で上限を持つので、常に全件を返す）。',
          responses: {
            200: jsonResponse('帳面の全件（古い順、末尾が最新）。', droppedResponseSchema),
          },
        }),
        async (c) => {
          const traces = recentDroppedTraces();
          return c.json(
            droppedResponseSchema.parse({
              origin: 'daemon',
              since: droppedTraceLedgerSince(),
              limit: RECENT_TRACE_LIMIT,
              total: traces.length,
              traces,
            }),
          );
        },
      )

      // 取れない行を 0 に丸めない: `unreadable` はストアが返したまま core へ渡す（Task は閉じた行を刈らないので、刈りの件数は無い）。`github` は観測の記録を返すだけ（デーモンは GitHub を見に行かない）。
      .get(
        '/progress',
        describeRoute({
          tags: ['progress'],
          summary: '作業の進捗（積み上がり・実施中・片付いた速度・見込み）',
          description:
            'Task（待ち行列の行。`GET /tasks`）と委譲（Job）の行を数え直した集計。`windowHours`（既定 ' +
            `${DEFAULT_PROGRESS_WINDOW_HOURS}）は速度と見込みを数える窓の長さ（時間、有限の正数）。` +
            '**率（%）は出さない**（task に総量が無く、分母が定まらない）。' +
            '`backlog.completeness` が 0 でなければ数は欠けうる。取れないものは 0 にせず ' +
            '`null` か `state` で言う（`forecast.state` が `unavailable` のとき数は作らない）。' +
            '`github` は観測の記録（道具 `github_observation_record` の記録）を返すだけで、デーモンは GitHub を見に行かない。' +
            '記録が無ければ `not_observed`（0 件ではない）。' +
            '中身の定義は `packages/core/src/progress.ts` の冒頭 doc を参照。',
          responses: {
            200: jsonResponse('進捗の集計。', progressResponseSchema),
            400: errorResponse('`windowHours` が有限の正数でない（空文字・非数・0以下・非有限）。'),
          },
        }),
        queryParams(progressQuery),
        async (c) => {
          const { windowHours: rawWindowHours } = c.req.valid('query');
          // 「渡されなかった」と「空文字が渡された」を分ける: `Number('')` は 0 で、core の窓の検査に任せると意図の読めない 400 になる。
          let windowHours = DEFAULT_PROGRESS_WINDOW_HOURS;
          if (rawWindowHours !== undefined) {
            if (rawWindowHours.trim() === '') {
              return c.json({ error: PROGRESS_WINDOW_HOURS_INVALID_MESSAGE }, 400);
            }
            windowHours = Number(rawWindowHours);
          }

          let view: Awaited<ReturnType<typeof readProgress>>;
          try {
            view = await readProgress(stores, { now: new Date(), windowHours });
          } catch (error) {
            // `windowHours` の検査だけを 400 にする: ストアの `RangeError` は握らない。
            if (error instanceof InvalidProgressWindowError) {
              return c.json({ error: PROGRESS_WINDOW_HOURS_INVALID_MESSAGE }, 400);
            }
            throw error;
          }

          return c.json(progressResponseSchema.parse(view));
        },
      )
  );
}
