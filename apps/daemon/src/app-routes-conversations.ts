import {
  countUnread,
  countUnreadConversations,
  effectiveReadThrough,
  loadConversationReadView,
  conversationMessages,
  readConversationPage,
  readConversationWindow,
  readConversationWindowPage,
  readWithdrawnClientMessageIds,
  describeMissingConversation,
  deleteConversation,
  decodeConversationCursor,
  encodeConversationCursor,
  InvalidConversationCursorError,
  type ConversationCursor,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  conversationDetailResponseSchema,
  conversationReadRequestSchema,
  conversationReadResponseSchema,
  conversationsResponseSchema,
  conversationDeleteResponseSchema,
  unreadConversationCountResponseSchema,
} from './openapi.js';
import { InvalidCursorError } from './cursor.js';
import { principalRefOf } from './app-context.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import {
  INVALID_QUERY_DESCRIPTION,
  jsonResponse,
  errorResponse,
  jsonBody,
  queryParams,
  readJournalEntry,
} from './app-shared.js';

// `scan` が数えるのは人間との往復だけ: マネージャーとの往復・内部ターン（`self`）はこの予算を食わない。黙って打ち切らない: `scanned` と `hiddenByLimit` を返して、遡り切れていないことを呼ぶ側に見せる。
const conversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
  // 中身は日誌の継続点（`{ id, at }`）: 同じミリ秒の同着も飛ばさず重複しない。`scan` の窓の外も継続点を辿れば読める。
  cursor: z.string().optional(),
});

// `z.coerce.boolean()` を使わない: `?includeSuperseded=false` が true になり、既定は編集後の版だけという約束が黙って壊れる。
const conversationQuery = z.object({
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
  includeSuperseded: z.enum(['true', 'false']).default('false'),
});

export function conversationsRoutes(ctx: AppContext) {
  const { clone, stores, receivedClientMessages, startedConversations, clock } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      .get(
        '/conversations',
        describeRoute({
          tags: ['conversations'],
          summary: '会話の一覧',
          description:
            '`POST /chat` の SSE は流すだけで読み直す口が無かった。器（端末・タブ・アプリ）' +
            'を替えても続きから話せるための一覧。日誌から組み立てるので新しい状態は持たない。' +
            '新しい順。`scanned` は人間との往復を何件遡ったか（マネージャーとの往復・内部' +
            'ターンは数えない。issue #418）、`reachedStart` はその窓が日誌の先頭に届いたかで、' +
            '遡り切れていないことが分かる（黙って打ち切らない）。`hiddenByLimit` は、その窓の' +
            '**中で** `limit` に収まらず落とした会話の数（窓の外は数えていない）。' +
            '続きが在る（`hiddenByLimit > 0` か `reachedStart` が偽）ときは `nextCursor` が載り、' +
            '次の呼びの `cursor` へそのまま渡すと、その続き（窓の外も含む）から読める。' +
            '`/approvals` と同じ形で、続きが無ければ `nextCursor` は無い。' +
            '壊れた `cursor`・指す発言が見当たらない `cursor` は 400。',
          responses: {
            200: jsonResponse('会話の一覧（新しい順）。', conversationsResponseSchema),
            400: errorResponse(
              'クエリが不正、または `cursor` が壊れている・指す発言が見当たらない。',
            ),
          },
        }),
        queryParams(conversationsQuery),
        async (c) => {
          const { limit, scan, cursor } = c.req.valid('query');
          let cursorPayload: ConversationCursor | undefined;
          if (cursor !== undefined) {
            const decoded = decodeConversationCursor(cursor);
            if (decoded === null) return c.json({ error: new InvalidCursorError().message }, 400);
            cursorPayload = decoded;
          }
          // 数え方は `collectConversations` が持つ: ここで数え直さない。
          const readView = await loadConversationReadView(
            stores.conversationReads,
            clock().toISOString(),
          );
          // 窓の組み立てを手組みし直さない: `with` を絞り忘れる余地が生まれる。クローンの道具（`conversation_read`）と同じ規則を通すので、人間には見えるがクローンには見えない、が増えない。
          let page: Awaited<ReturnType<typeof readConversationPage>>;
          try {
            page = await readConversationPage(stores.journal, {
              limit,
              scan,
              readView,
              ...(cursorPayload === undefined ? {} : { cursor: cursorPayload }),
            });
          } catch (error) {
            // 継続点が指す発言が見当たらないのは判定できないという第3の状態: 黙って先頭から返さず 400 にする。
            if (error instanceof InvalidConversationCursorError) {
              return c.json({ error: error.message }, 400);
            }
            throw error;
          }
          const conversations = page.conversations.map(({ unread, ...summary }) => ({
            ...summary,
            unreadCount: unread,
          }));
          return c.json({
            conversations,
            ...(readView.unreadable === undefined
              ? {}
              : { readStateUnreadable: readView.unreadable }),
            scanned: page.scanned,
            reachedStart: page.reachedStart,
            // 窓の中の数であって窓の外は数えていない: `reachedStart` が偽ならさらに古い会話が在りうる（その場合も `nextCursor` が載る）。
            hiddenByLimit: page.hiddenByLimit,
            // `hiddenByLimit > 0` か `reachedStart === false` なら載る: 窓の外が残るのに黙って途切れない。`reachedStart: false` は窓が `scan` 件ちょうどだっただけのこともあるので、辿った先が空で終わることはある（安全側）。
            ...(page.next === null ? {} : { nextCursor: encodeConversationCursor(page.next) }),
          });
        },
      )

      // `/conversations/:id` より前に置く: `:id` に `unread-count` が食われる。
      .get(
        '/conversations/unread-count',
        describeRoute({
          tags: ['conversations'],
          summary: '未読のある会話の数',
          description:
            '未読のある会話の数（全会話で数える。直近の一覧には限らない）。**日誌を広く遡らない** — ' +
            '会話ごとの最後のクローン側発言の時刻の索引（日誌の写し）を、前回の続きから' +
            '新しく積まれた分だけ足して数える。未読の会話が上限（99）を超えるとき、または長い' +
            '不在のあとの取り込みが1回に収まらないときは `capped: true`（`count` は下限。UI は「N+」）。' +
            '一覧の `unreadCount` との差が出うるのは、編集で畳まれた返答が会話の最後のクローン側発言のとき' +
            '（その会話を開いて既読にすれば揃う）。既読の記録が読めないときは `readStateUnreadable` が載る。',
          responses: {
            200: jsonResponse('未読のある会話の数。', unreadConversationCountResponseSchema),
          },
        }),
        async (c) => {
          const result = await countUnreadConversations({
            journal: stores.journal,
            reads: stores.conversationReads,
            now: clock().toISOString(),
          });
          return c.json(result);
        },
      )

      .get(
        '/conversations/:id',
        describeRoute({
          tags: ['conversations'],
          summary: '1つの会話の中身（古い順）',
          description:
            '1つの会話の中身（古い順）。器を替えても続きから話せるための口。' +
            '**黙って打ち切らない** — `scanned`（この会話の人間との往復を何件遡ったか。他の会話・マネージャー' +
            'との往復・内部ターンは数えない。issue #418）でどこまで遡ったか、' +
            '`reachedStart` で窓がこの会話の先頭に届いたかを返す。`404` は `reachedStart` が' +
            '真のときだけ返る（「無い」と「遡り切れていない」を同じ応答にしないため）。' +
            '**既定（`includeSuperseded` を渡さない）では、チャットで編集され既定ビューから' +
            '畳まれた旧発言・その応答を除く。** 応答の `supersededCount` に畳まれた件数を' +
            '常に含める（0件でも含める）。`includeSuperseded=true` を渡すと畳まれた分も' +
            '含めて返し、各発言に編集の関係（`supersedes` / `supersededBy`）が付く。',
          responses: {
            200: jsonResponse(
              '会話の中身。`reachedStart` が偽なら、窓の外に続きが残っている可能性がある。' +
                '`messages` が空でこれが偽の場合は「無い」ではなく**判定できない**。',
              conversationDetailResponseSchema,
            ),
            400: errorResponse(INVALID_QUERY_DESCRIPTION),
            404: errorResponse(
              '該当する会話が無い（内部ターン `self` は含まれない）。**遡り切れた場合だけ** — ' +
                '窓の外かもしれないときは 200 で `reachedStart: false` を返す。',
            ),
          },
        }),
        queryParams(conversationQuery),
        async (c) => {
          const id = c.req.param('id');
          const { scan, includeSuperseded: includeSupersededRaw } = c.req.valid('query');
          const includeSuperseded = includeSupersededRaw === 'true';
          // この会話の行だけをストア側で絞る: 全会話の窓を読んでから絞ると、他の会話の往復が `scan` を食い尽くして古い会話が空に見えるため。
          const window = await readConversationWindowPage(stores.journal, {
            scan,
            conversationId: id,
          });
          const entries = window.entries;
          // 常に `includeSuperseded: true` で1回だけ呼ぶ: 既定の応答でも `supersededCount` を数える必要があるので、まず畳まれた分も含めて取り、既定ビューに戻すかはここでふるう。応答に載せる項目は明示して写す（共有の型の項目が増えても応答が増えない）。
          const allMessages = conversationMessages(entries, id, { includeSuperseded: true });
          const supersededCount = allMessages.filter(
            (message) => message.supersededBy !== undefined,
          ).length;
          const visible = includeSuperseded
            ? allMessages
            : allMessages.filter((message) => message.supersededBy === undefined);
          // 進行中の状態（走っている・順番待ち）は `GET /chat/:id/stream` の `open.pending` が持つので、ここでは持たない。
          const idsToCheck = visible.filter(
            (message) => message.role === 'inbound' && message.clientMessageId !== undefined,
          );
          const withdrawnIds =
            idsToCheck.length === 0
              ? new Set<string>()
              : await readWithdrawnClientMessageIds(
                  stores.journal,
                  id,
                  idsToCheck.reduce(
                    (oldest, message) => (message.at < oldest ? message.at : oldest),
                    idsToCheck[0]!.at,
                  ),
                );
          const messages = visible.map((message) => ({
            id: message.id,
            at: message.at,
            role: message.role,
            text: message.text,
            ...(message.role === 'inbound' &&
            message.clientMessageId !== undefined &&
            withdrawnIds.has(message.clientMessageId)
              ? { delivery: 'withdrawn' as const }
              : {}),
            ...(message.supersedes === undefined ? {} : { supersedes: message.supersedes }),
            ...(message.supersededBy === undefined ? {} : { supersededBy: message.supersededBy }),
            ...(message.turnFailure === undefined ? {} : { turnFailure: message.turnFailure }),
            ...(message.turnFailureKind === undefined
              ? {}
              : { turnFailureKind: message.turnFailureKind }),
            ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
            ...(message.clientMessageId === undefined
              ? {}
              : { clientMessageId: message.clientMessageId }),
          }));

          // 終端は件数から推さない: 読めない行を捨てて短くなった窓を「先頭に届いた」と誤り、窓の外の会話を 404 にしてしまうため
          const reached = window.reachedStart;

          // 一律 404 にしない: 消えた会話とまだ見ていない会話が区別できなくなる。遡り切れているときだけ「無い」と言い、切れていなければ空の結果に `reachedStart: false` を添えて判定を呼ぶ側へ渡す。
          if (messages.length === 0 && reached) {
            return c.json({ error: 'not found' as const }, 404);
          }
          const readView = await loadConversationReadView(
            stores.conversationReads,
            clock().toISOString(),
          );
          const readThrough = effectiveReadThrough(readView, id);
          return c.json({
            conversationId: id,
            messages,
            readThrough,
            // 既定ビューで見えている発言で数える（`includeSuperseded` に左右されない）。
            unreadCount: countUnread(
              allMessages.filter((message) => message.supersededBy === undefined),
              readThrough,
            ),
            ...(readView.unreadable === undefined
              ? {}
              : { readStateUnreadable: readView.unreadable }),
            scanned: entries.length,
            reachedStart: reached,
            // `includeSuperseded` によらず常に含める: 出ないと人間の側の器も畳まれた版の存在に気づけない。
            supersededCount,
          });
        },
      )

      // `through` は発言の id で時刻は日誌から引く: クライアントから時刻を受け取ると「いま」で既読にして見ていない分まで既読にする誤りが起きる。
      .post(
        '/conversations/:id/read',
        describeRoute({
          tags: ['conversations'],
          summary: '会話を既読にする（位置を進める）',
          description:
            '既読の位置（全員で1組）を、`through` で指した発言の時刻まで進める。**`through` は' +
            '発言の id**（`GET /conversations/:id` の `messages[].id`）で、時刻はサーバが日誌から' +
            '引く。**戻らない**——いまの位置より古い発言を指しても何も変わらず、200 でいまの' +
            '位置を返す。発言が無い・人間との往復でないときは 404、別の会話の発言のときは 400。' +
            '応答は進めた後の実効の位置と未読数（一覧・詳細と同じ数え方。窓は既定の `scan`）。',
          responses: {
            200: jsonResponse(
              '進めた後の実効の既読の位置と未読数。',
              conversationReadResponseSchema,
            ),
            400: errorResponse('本文が不正、または `through` の発言がこの会話のものでない。'),
            404: errorResponse('`through` の発言が日誌に無い（人間との往復でない場合を含む）。'),
            409: errorResponse(
              '`through` の発言は日誌に**在るが読めない**（形が合わない壊れた行。404 の「無い」とは別。' +
                '既読の位置は動かしていない）。',
            ),
          },
        }),
        jsonBody(conversationReadRequestSchema),
        async (c) => {
          const id = c.req.param('id');
          const { through } = c.req.valid('json');
          const targetRead = await readJournalEntry(stores, through);
          // 在るが読めない行を「見つからない」（404）と言わない。
          if (targetRead.kind === 'unreadable') return c.json({ error: targetRead.message }, 409);
          const target = targetRead.value;
          if (target === null || target.type !== 'exchange' || target.with !== 'human') {
            return c.json({ error: `発言 ${through} は見つからない` as const }, 404);
          }
          if (target.conversationId !== id) {
            return c.json(
              {
                error: `発言 ${through} はこの会話のものではない。**既読の位置は動かしていない。**`,
              },
              400,
            );
          }
          const now = clock().toISOString();
          // 基準時刻が無ければ先に決める: 位置より後に基準時刻が決まる順を作らない。
          await stores.conversationReads.ensureBaseline(now);
          await stores.conversationReads.advance(id, target.at);
          const readView = await loadConversationReadView(stores.conversationReads, now);
          const entries = await readConversationWindow(stores.journal, {
            scan: conversationsQuery.shape.scan.parse(undefined),
            conversationId: id,
          });
          const readThrough = effectiveReadThrough(readView, id);
          const visible = conversationMessages(entries, id);
          return c.json({
            conversationId: id,
            readThrough,
            unreadCount: countUnread(visible, readThrough),
            ...(readView.unreadable === undefined
              ? {}
              : { readStateUnreadable: readView.unreadable }),
          });
        },
      )

      // クローンの道具には同じ口を作らない: 消すのは持ち主の判断（オーナーの指定）。
      .delete(
        '/conversations/:id',
        describeRoute({
          tags: ['conversations'],
          summary: '会話を削除する（論理削除。どの読む口からも出なくなる）',
          description:
            '日誌に監査の墓標（`conversation_deleted`。誰が・いつ・どの会話を・何件）を1行積み、その会話の発言を' +
            '`GET /conversations`・`/conversations/:id`・未読数・`GET /journal`・`/journal/stream`・' +
            'クローンの `conversation_read` / `journal_read` を含む、日誌を読むすべての口から外す。' +
            '**本文はどこにも写さない。** 日誌の行は書き換えない（DB には残る。論理削除）。' +
            'その会話の発言に付いた添付と、Task（`task_list`）のその会話を起点とする行（未了・閉じた行とも。件数は `tasksRemoved`）は物理的に消す。その Task の本文を写した日誌の行（Task の id を含む `decision`）は、墓標の `hiddenEntryIds` で読む口から外す（行は書き換えない）。Task へ移さなかった旧台帳（廃止済み。テーブルも落とした）の行の本文を写した日誌の行は、会話との結び付きが分からないので、この削除では外せない。' +
            '受信箱の未処理の発言を外し、開いている `GET /chat/:id/stream` を閉じる（以後は 404）。' +
            '消した会話へは書けない（`POST /chat` は 404）。' +
            '**消せないもの**（クローンの SDK セッションの生ログ・archive・いまの文脈・蒸留済みの記憶・日報）は `remainsIn` に文で返す。' +
            '墓標の後の手当てが落ちたら、会話は外れたまま `incomplete` にそれを返す（200）。',
          responses: {
            200: jsonResponse('削除した。', conversationDeleteResponseSchema),
            403: errorResponse('許可（`access grant`）の無いアカウント、または連携の鍵。'),
            404: errorResponse(
              'その会話は無い（既に削除済みを含む。`code: conversation_not_found`）。前方一致では消さない。',
            ),
          },
        }),
        async (c) => {
          const id = c.req.param('id');
          const result = await deleteConversation(
            {
              stores,
              dropQueuedInboxEvents: (ids) => clone.dropQueuedInboxEvents(ids),
              ...(clone.forgetConversation === undefined
                ? {}
                : {
                    forgetConversation: (conversationId) =>
                      clone.forgetConversation?.(conversationId),
                  }),
            },
            { conversationId: id, deletedBy: principalRefOf(c.get('principal')) },
          );
          if (!result.deleted) {
            return c.json(
              {
                error: describeMissingConversation(id, result.lookup),
                code: 'conversation_not_found' as const,
              },
              404,
            );
          }
          // メモリに残る会話 id の控えも落とす: 消した会話を「振った id」として受け直さない。
          startedConversations.delete(id);
          for (const [clientMessageId, received] of receivedClientMessages) {
            if (received.conversationId === id) receivedClientMessages.delete(clientMessageId);
          }
          return c.json(conversationDeleteResponseSchema.parse(result));
        },
      )
  );
}
