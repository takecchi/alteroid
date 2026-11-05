import type { Stores } from '@alteroid/core';
import {
  approvalSelectionSchema,
  stripNul,
  UnreadablePermissionGrantError,
  delegatedPermissionRuleOf,
  approvalUpdatedAt,
  compareApprovalPagingKey,
  localDayRange,
  reasonOf,
  describeSelectionsViolation,
  toRowsUnreadable,
  traceApproval,
  UnreadableApprovalError,
  type ApprovalPagingKey,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  approvalsAnswerResponseSchema,
  approvalByIdResponseSchema,
  approvalsAnsweredDatesResponseSchema,
  approvalsResponseSchema,
  approvalTraceResponseSchema,
  okResponseSchema,
  permissionGrantsResponseSchema,
} from './openapi.js';
import { InvalidCursorError, decodeCursor, encodeCursor } from './cursor.js';
import { answeredDates, approvalSettledDate, approvalsSettledOn } from './approvals-answered.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  deliberateClient,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  jsonResponse,
  errorResponse,
  invalidWith,
  REQUIRED_JSON_BODY,
  jsonBody,
  queryParams,
  describeActor,
  appendJournalOrDrop,
  readOrUnreadable,
  unreadableRowsRemoveHandlers,
  answerApprovalViaOf,
} from './app-shared.js';

const answerFields = {
  answer: z.string().min(1).optional(),
  selections: z.array(approvalSelectionSchema).min(1).optional(),
};
// 形の検査で弾く: `text/plain` で JSON を送る CSRF は本文が空として読まれるので、両方が任意でも空の本文を 404 / 409 の判定まで進ませない。
const hasAnswerOrSelections = (body: { answer?: unknown; selections?: unknown }) =>
  body.answer !== undefined || body.selections !== undefined;
// `selections` と併用する `answer` は補足なので、空白だけでもここでは見ない（`describeSelectionsViolation` が扱う）。値は書き換えない。
const answerIsNotBlank = (body: { answer?: string; selections?: unknown }) =>
  body.selections !== undefined ||
  body.answer === undefined ||
  stripNul(body.answer).trim().length > 0;
const withAnswerChecks = <
  T extends z.ZodType<{ answer?: string | undefined; selections?: unknown }>,
>(
  schema: T,
) =>
  schema
    .refine(hasAnswerOrSelections, { message: 'answer も selections も無い' })
    .refine(answerIsNotBlank, { message: 'answer が空白だけ', path: ['answer'] });
const answerBody = withAnswerChecks(z.object(answerFields));

const answersBody = z.object({
  answers: z
    .array(withAnswerChecks(z.object({ id: z.string().min(1), ...answerFields })))
    .min(1)
    .max(200),
});

// `limit` に上限（`max`）を付けない: この口は既定で全件を返すので上限を置いても何も守れない。`conversationId` は絞り込みで、頁の封筒（`total` / `nextCursor`）は増えない。
const approvalsQuery = z.object({
  pending: z.enum(['true', 'false']).default('true'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
  conversationId: z.string().optional(),
  // `pending=true`（明示）・`order` / `limit` / `cursor` とは併用できない（400）: 並びは決着の新しい順で固定なので意味を持たず、黙って片方を無視しない。
  answeredOn: z.string().optional(),
});

// 封筒は持たない——続きが在るかは `limit` 件ちょうど返ったかで判る。
const approvalsAnsweredDatesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).default(7),
  beforeDate: z.string().optional(),
});

// 位置（index）ではなく `(createdAt, id)` の比較で辿る: fs の `putApproval` は既存 id への書き込みで配列の末尾へ移動するので、頁の間に誰かが答えると位置がずれて1件飛ばす（インメモリの `Map` では再現しない。歯は `packages/storage-fs/src/index.test.ts` に置く）。`id` は同時刻の同着を割る補助キー。
// `createdAt` を文字列のまま比較する: `new Date().toISOString()` の固定形式（UTC・ミリ秒3桁・`Z` 終端）に乗っている。
const approvalsCursorSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

const NO_PENDING_APPROVAL_DESCRIPTION = '該当する承認待ちが無い。';

const readApproval = (stores: Pick<Stores, 'jobs'>, id: string) =>
  readOrUnreadable(() => stores.jobs.getApproval(id), UnreadableApprovalError);

// `instanceof` ではなく `name` と `settled` で見分ける: `CloneHost` の向こうの実装を差し替えるテストの偽物でも、同じ形で投げれば同じ扱いになる。
function approvalSettledKindOf(error: unknown): 'answered' | 'withdrawn' | undefined {
  if (!(error instanceof Error) || error.name !== 'ApprovalAlreadySettledError') return undefined;
  const settled = (error as Error & { settled?: unknown }).settled;
  return settled === 'answered' || settled === 'withdrawn' ? settled : undefined;
}

export function approvalsRoutes(ctx: AppContext, deps: AppDeps) {
  const { clone, stores } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      .get(
        '/approvals',
        describeRoute({
          tags: ['approvals'],
          summary: '承認待ちの一覧',
          description:
            '`ask_human` が積んだ承認待ち。既定では未回答のみ（`pending=false` で全部）。' +
            '行が読めない（版ずれ・手編集）承認待ちが在るときだけ、`unreadable`（id が取れれば id と' +
            '不正な欄名）が載る。**壊れた行であって、回答済みでも取り下げ済みでもない。**' +
            '0件なら鍵ごと無い。窓（`limit`/`cursor`）では切らない（issue #2298）。`conversationId` を渡すと、' +
            '`unreadable` は生の行の `conversationId` がその会話と一致する行だけになる（会話の id すら読めない行と' +
            'ほかの会話の壊れた行は載らない。全件は `conversationId` を渡さない呼びで見る。issue #3319）。' +
            '`order` / `limit` / `cursor` のいずれかを明示すると頁の封筒（`total` /' +
            '`nextCursor`）が応答へ載る。**明示しない既定の呼びは、この変更の前と応答が' +
            '1バイトも変わらない**（opt-in。`.claude/skills/listing-and-detail/SKILL.md`' +
            'の考え方と同じ——足すのは能力であって、既存の呼び手に新しい欄を押し付け' +
            'ない）。並びは `order`（既定 `asc`）で、`(createdAt, id)` の比較で決める' +
            '（ストアの生の並びには乗らない。理由は `apps/daemon/src/app-routes-approvals.ts` の' +
            '`approvalsCursorSchema` の doc）。`conversationId` を渡すと、その会話で' +
            '上がった確認だけに絞る（`pending`/`order`/`limit`/`cursor` と併用できる）。' +
            '`answeredOn=YYYY-MM-DD`（opt-in）を渡すと、**その日（デーモンの `localDate()` で決まる日。' +
            '日報と同じ区切り）に決着した承認だけ**を、決着の新しい順（同時刻は id の降順）に返す。' +
            '**決着の日時は `answeredAt`、無ければ `withdrawnAt`**（取り下げ済みも決着した件。外すと' +
            '取り下げ済みが画面から見えなくなる）。日付の形が不正（2月30日など）、`pending=true` の' +
            '明示、`order`/`limit`/`cursor` との併用は 400。この指定では `unreadable` は載せない。',
          responses: {
            200: jsonResponse('承認待ちの一覧。', approvalsResponseSchema),
            400: errorResponse('クエリが不正、または `cursor` が壊れている・`order` と食い違う。'),
          },
        }),
        queryParams(approvalsQuery),
        async (c) => {
          const { pending, order, limit, cursor, conversationId, answeredOn } =
            c.req.valid('query');
          // opt-in の判定は生のクエリで行う: `order` は既定値を持つので `c.req.valid('query')` だけでは「渡されたか」が分からない。
          const optedIn =
            c.req.query('order') !== undefined ||
            c.req.query('limit') !== undefined ||
            c.req.query('cursor') !== undefined;

          // `pending` は既定値を持つので、明示されたかは生のクエリで見る（`optedIn` と同じ理由）。
          if (answeredOn !== undefined) {
            if (c.req.query('pending') === 'true') {
              return c.json({ error: 'answeredOn は pending=true と併用できない' }, 400);
            }
            if (optedIn) {
              return c.json({ error: 'answeredOn は order / limit / cursor と併用できない' }, 400);
            }
            const day = localDayRange(answeredOn);
            if (day === null) {
              return c.json({ error: 'answeredOn は YYYY-MM-DD で指定する' as const }, 400);
            }
            // 器が DB の側で決着の時刻で絞れるなら絞る（#5089）。絞った後も同じ関数で日を決め直すので、結果は全部読んだときと同じ
            const settled = await stores.jobs.listApprovalsSettledAround(
              { since: day.since.toISOString(), until: day.until.toISOString() },
              conversationId === undefined ? {} : { conversationId },
            );
            const onDay = approvalsSettledOn(settled.entries, answeredOn);
            // `unreadable` は載せない: 読めない行は決着の日時も分からず、どの日にも置けない。
            return c.json(
              approvalsResponseSchema.parse({
                approvals: onDay.map((approval) => ({
                  ...approval,
                  updatedAt: approvalUpdatedAt(approval),
                })),
              }),
            );
          }

          // `conversationId` の絞りはストアに渡す: 全件を取ってメモリで絞ると、会話を開くたびの費用が承認の総数に比例する。`total` は絞り込みを当てた後の件数。
          const approvalList = await stores.jobs.listApprovals({
            pendingOnly: pending !== 'false',
            ...(conversationId === undefined ? {} : { conversationId }),
          });
          const approvals = approvalList.entries;
          const total = approvals.length;

          let cursorPayload: (ApprovalPagingKey & { order: 'asc' | 'desc' }) | undefined;
          if (cursor !== undefined) {
            try {
              cursorPayload = decodeCursor(cursor, approvalsCursorSchema);
            } catch (error) {
              if (error instanceof InvalidCursorError) {
                return c.json({ error: error.message }, 400);
              }
              throw error;
            }
            // 黙って別の向きの頁を返さない: カーソルは決めた向きの中でしか意味を持たない。
            if (cursorPayload.order !== order) {
              return c.json({ error: 'カーソルの order がリクエストの order と食い違う' }, 400);
            }
            // id の実在は検査しない: 指していた行が `pending` の絞りから消えていても、比較さえできれば続きは正しく決まる。
          }

          // 既定の呼びも並べる: ストアの生の並びは実装ごとに違い（fs は回答で書き直した行が末尾へ動く）、説明の「(createdAt, id) の比較で決める」と食い違うため。
          const compare = compareApprovalPagingKey(order);
          let view = [...approvals].sort(compare);
          if (optedIn && cursorPayload !== undefined) {
            const pivot = cursorPayload;
            view = view.filter((approval) => compare(approval, pivot) > 0);
          }

          const page = optedIn && limit !== undefined ? view.slice(0, limit) : view;
          const hasMore = optedIn && page.length < view.length;
          const lastOfPage = page[page.length - 1];

          const responseBody: {
            approvals: unknown[];
            unreadable?: unknown[];
            total?: number;
            nextCursor?: string;
          } = {
            approvals: page.map((approval) => ({
              ...approval,
              updatedAt: approvalUpdatedAt(approval),
            })),
          };
          // 0 件なら鍵ごと無い: 空配列は「読めない行は 0 件」と読め、既存の呼び手の応答も変わる。窓（`limit`/`cursor`）では切らない。
          if (approvalList.unreadable.length > 0) responseBody.unreadable = approvalList.unreadable;
          if (optedIn) {
            responseBody.total = total;
            if (hasMore && lastOfPage !== undefined) {
              responseBody.nextCursor = encodeCursor({
                id: lastOfPage.id,
                createdAt: lastOfPage.createdAt,
                order,
              });
            }
          }
          return c.json(approvalsResponseSchema.parse(responseBody));
        },
      )

      // `GET /approvals/:id` はこの経路より後ろに登録する: 先だと `answered-dates` が id として読まれる（`approvals-answered.test.ts` が固定する）。
      .get(
        '/approvals/answered-dates',
        describeRoute({
          tags: ['approvals'],
          summary: '承認が決着した日と件数',
          description:
            '回答済み・取り下げ済みの承認について、**決着した日**（デーモンの `localDate()`。日報と同じ区切り）' +
            'ごとの件数を**新しい日が上**の順に返す。決着の日時は `answeredAt`、無ければ `withdrawnAt`' +
            '（`GET /approvals?answeredOn=` と同じ意味）。`limit`（既定 7・上限 365。`GET /reports` と同じ）と' +
            '`beforeDate`（前の頁の最後の日。**それより古い日**を返す）で続きを取る。**封筒は持たない**' +
            ' — 続きが在るかは `limit` 件ちょうど返ったかで判る。',
          responses: {
            200: jsonResponse(
              '決着のあった日と件数（日付の新しい順）。',
              approvalsAnsweredDatesResponseSchema,
            ),
            400: errorResponse('クエリが不正、または `beforeDate` が `YYYY-MM-DD` 形式ではない。'),
          },
        }),
        queryParams(approvalsAnsweredDatesQuery),
        async (c) => {
          const { limit, beforeDate } = c.req.valid('query');
          if (beforeDate !== undefined && localDayRange(beforeDate) === null) {
            return c.json({ error: 'beforeDate は YYYY-MM-DD で指定する' as const }, 400);
          }
          // 器が決着の時刻だけを読めるなら、承認の本文を読まない（#5089）
          const settled = (await stores.jobs.listApprovalSettledAts()).map((answeredAt) => ({
            answeredAt,
          }));
          return c.json({
            dates: answeredDates(settled, {
              limit,
              ...(beforeDate === undefined ? {} : { beforeDate }),
            }),
          });
        },
      )

      // `settledOn` は `GET /approvals?answeredOn=` の日と同じ関数（`approvalSettledDate`）で決める。在るが読めない行は 409（「無い」と言わない）。
      .get(
        '/approvals/:id',
        describeRoute({
          tags: ['approvals'],
          summary: '承認を id で1件読み、決着した日を返す',
          description:
            '承認1件と、決着した日（`settledOn`。デーモンの `localDate()`・日報と同じ区切り。決着の日時は ' +
            '`answeredAt`、無ければ `withdrawnAt`。`GET /approvals?answeredOn=` と同じ意味）を返す。' +
            '未回答・未取り下げなら `settledOn` は `null`。回答済みの詳細（`/approvals/answered/<日>/<id>`）へ' +
            '移るために、一覧を引かずに日を知る口。',
          responses: {
            200: jsonResponse('承認と決着した日。', approvalByIdResponseSchema),
            404: errorResponse(NO_PENDING_APPROVAL_DESCRIPTION),
            409: errorResponse(
              '承認待ちの行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
            ),
          },
        }),
        async (c) => {
          const read = await readApproval(stores, c.req.param('id'));
          if (read.kind === 'unreadable') return c.json({ error: read.message }, 409);
          const approval = read.value;
          if (approval === null) return c.json({ error: 'not found' as const }, 404);
          return c.json(
            approvalByIdResponseSchema.parse({
              approval: { ...approval, updatedAt: approvalUpdatedAt(approval) },
              settledOn: approvalSettledDate(approval) ?? null,
            }),
          );
        },
      )

      .get(
        '/approvals/:id/trace',
        describeRoute({
          tags: ['approvals'],
          summary: '承認の答えとその後の行動を対で読む',
          description:
            '問い・答え（日誌の行と承認待ちの器）と、答えを受けたターンでクローンが書いた行' +
            '（`answeredApprovalId` がこの承認を指すもの）を古い順に返す。対が無いときは `state` が' +
            '理由を分ける（`unanswered` / `withdrawn` / `no_turn_start` / ' +
            '`turn_before_recording`＝この記録を始める前の答えなので記録していない / ' +
            '`unstamped_actions`＝記録が動いていない疑い / `no_actions`）。' +
            '一般化した基準は返さない（issue #847）。',
          responses: {
            200: jsonResponse('対（無ければ理由つき）。', approvalTraceResponseSchema),
            404: errorResponse(NO_PENDING_APPROVAL_DESCRIPTION),
            409: errorResponse(
              '承認待ちの行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
            ),
          },
        }),
        async (c) => {
          const read = await readOrUnreadable(
            () => traceApproval(stores, c.req.param('id')),
            UnreadableApprovalError,
          );
          // 在るが読めない行を「無い」（404）と言わない。
          if (read.kind === 'unreadable') return c.json({ error: read.message }, 409);
          const trace = read.value;
          if (trace === null) return c.json({ error: 'not found' as const }, 404);
          return c.json(approvalTraceResponseSchema.parse(trace));
        },
      )

      .post(
        '/approvals/answer',
        describeRoute({
          tags: ['approvals'],
          summary: '溜まった承認待ちにまとめて答える',
          description:
            '1件が駄目でも残りは進める（人間の不在で止まっていたそれぞれの仕事が、答えた順に' +
            '独立に再開する）。結果は `answers` と同じ順で返る。行が在るが読めない件は、その件だけ' +
            '`ok: false` と読めない旨の `error` で返る（`not found` とは言わない）。' +
            '各件は `answer`（自由文）か `selections`（`questions` を持つ承認待ちへの選択肢の回答。' +
            '`answer` は補足として併用できる）の少なくとも一方を持つ。**`selections` が `questions` と' +
            '突き合わない件が1つでもあれば、1件も答えずに全体を 400 にする**（知らない設問・選択肢の id、' +
            '単一選択で2つ以上、`allowOther: false` なのに `other`、同じ設問が2回、`questions` を持たない' +
            '承認待ちへの `selections`）。',
          responses: {
            200: jsonResponse('各件の結果（1件ごとの成否）。', approvalsAnswerResponseSchema),
            400: errorResponse(
              '本文が JSON として不正。または `answer` も `selections` も無い件・`selections` が' +
                '`questions` と突き合わない件がある（この場合、どの件も答えていない）。',
            ),
          },
        }),
        jsonBody(answersBody, invalidWith('answers の形が不正')),
        async (c) => {
          const results: { id: string; ok: boolean; error?: string }[] = [];
          const { answers } = c.req.valid('json');
          // 形の不正は1件も答える前に全体を 400 にする: `selections` が `questions` と突き合わないのは要求の誤りで、件ごとの成否とは違い、残りだけ進めると書いたつもりの件が黙って落ちる。まだ回答待ちの件にだけ突き合わせる（他は下で件ごとの理由として返す）。
          for (const item of answers) {
            if (item.selections === undefined) continue;
            const pendingRead = await readApproval(stores, item.id);
            const pending = pendingRead.kind === 'read' ? pendingRead.value : null;
            if (
              pending === null ||
              pending.answeredAt !== undefined ||
              pending.withdrawnAt !== undefined
            ) {
              continue;
            }
            const violation = describeSelectionsViolation(
              pending.questions,
              item.selections,
              item.answer,
            );
            if (violation !== null) {
              return c.json({ error: `selections が不正: ${item.id}: ${violation}` }, 400);
            }
          }
          for (const { id, answer, selections } of answers) {
            const read = await readApproval(stores, id);
            // この1件だけ「在るが読めない」と返し、残りは進める（`not found` と言わない）。
            if (read.kind === 'unreadable') {
              results.push({ id, ok: false, error: read.message });
              continue;
            }
            const approval = read.value;
            if (!approval) {
              results.push({ id, ok: false, error: 'not found' });
              continue;
            }
            if (approval.answeredAt !== undefined) {
              results.push({ id, ok: false, error: 'already answered' });
              continue;
            }
            // 取り下げ済みは回答できない: `putApproval` が上書きして `withdrawnAt` と `answeredAt` が同時に立った行を作り、クローンが止めたつもりの仕事を人間の回答が再開しうる（`clone.ts` の `human_answer` は `answeredAt` の有無しか見ない）。
            if (approval.withdrawnAt !== undefined) {
              results.push({ id, ok: false, error: 'withdrawn' });
              continue;
            }
            try {
              await clone.answerApproval(
                id,
                answer ?? '',
                answerApprovalViaOf(c.get('principal')),
                selections,
              );
              results.push({ id, ok: true });
            } catch (error) {
              // 先の判定を通った後に別の回答・取り下げが先に届いていた: 先の判定と同じ語で返す。
              const settled = approvalSettledKindOf(error);
              results.push({
                id,
                ok: false,
                error:
                  settled === 'answered'
                    ? 'already answered'
                    : settled === 'withdrawn'
                      ? 'withdrawn'
                      : error instanceof UnreadableApprovalError
                        ? error.message
                        : error instanceof Error && error.name === 'InvalidApprovalSelectionsError'
                          ? error.message
                          : reasonOf(error),
              });
            }
          }
          return c.json({ results });
        },
      )

      .post(
        '/approvals/:id/answer',
        describeRoute({
          tags: ['approvals'],
          summary: '承認待ちに1件答える',
          description:
            '二度答えると、既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も上書きされる。' +
            '答え直したいなら新しい確認として来るのが正しい（→ 409）。' +
            'クローンが approval_withdraw で取り下げた件も答えられない（→ 409 error="withdrawn"。#963）。' +
            '`answer`（自由文）か `selections`（`questions` を持つ承認待ちへの選択肢の回答）の少なくとも' +
            '一方が要る。`selections` があれば `answer` は省略でき、併用すると補足になる。デーモンが' +
            '設問・選択肢・その他・補足を人間が読める文に畳んで回答として残す（構造は `selections` に残る。' +
            '未回答の設問があってもよい）。',
          requestBody: REQUIRED_JSON_BODY,
          responses: {
            200: jsonResponse('答えた。', okResponseSchema),
            400: errorResponse(
              '本文が JSON として不正。または `answer` も `selections` も無い・`selections` が' +
                '`questions` と突き合わない（知らない設問・選択肢の id、単一選択で2つ以上、' +
                '`allowOther: false` なのに `other`、同じ設問が2回、`questions` を持たない承認待ちへの' +
                '`selections`）。回答は書いていない。',
            ),
            404: errorResponse(NO_PENDING_APPROVAL_DESCRIPTION),
            409: errorResponse(
              '既に回答済み・取り下げ済み。または承認待ちの行は在るが読めない形で入っている' +
                '（版ずれ・手編集。消されたのではない。回答は書いていない）。',
            ),
          },
        }),
        jsonBody(answerBody, invalidWith('answer の形が不正')),
        async (c) => {
          const id = c.req.param('id');
          const read = await readApproval(stores, id);
          // 在るが読めない行を「無い」（404）と言わない。
          if (read.kind === 'unreadable') return c.json({ error: read.message }, 409);
          const approval = read.value;
          if (!approval) return c.json({ error: 'not found' as const }, 404);
          // 二度答えると既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も上書きされる。
          if (approval.answeredAt !== undefined) {
            return c.json({ error: 'already answered' as const }, 409);
          }
          // 取り下げ済みも答えられない（上のバルク版と同じ理由）。
          if (approval.withdrawnAt !== undefined) {
            return c.json({ error: 'withdrawn' as const }, 409);
          }
          const body = c.req.valid('json');
          if (body.selections !== undefined) {
            const violation = describeSelectionsViolation(
              approval.questions,
              body.selections,
              body.answer,
            );
            if (violation !== null)
              return c.json({ error: `selections が不正: ${violation}` }, 400);
          }
          try {
            await clone.answerApproval(
              id,
              body.answer ?? '',
              answerApprovalViaOf(c.get('principal')),
              body.selections,
            );
          } catch (error) {
            // クローンの側の検査が先の検査を通り抜けた窓（別の実装・テストの偽物）。
            if (error instanceof Error && error.name === 'InvalidApprovalSelectionsError') {
              return c.json({ error: error.message }, 400);
            }
            // 先の判定を通った後に別の回答・取り下げが先に届いていた: 先の判定と同じ 409 で返す。
            const settled = approvalSettledKindOf(error);
            if (settled === 'answered') return c.json({ error: 'already answered' as const }, 409);
            if (settled === 'withdrawn') return c.json({ error: 'withdrawn' as const }, 409);
            // 先の `getApproval` の後に行が読めなくなった窓。
            if (error instanceof UnreadableApprovalError)
              return c.json({ error: error.message }, 409);
            throw error;
          }
          return c.json({ ok: true });
        },
      )

      .get(
        '/permission-grants',
        describeRoute({
          tags: ['permission-grants'],
          summary: '人間が承認した Bash 許可の一覧',
          description:
            '`request_permission` の要求に人間が「許可します」と定型文でちょうど答え、かつ' +
            '許可されたアカウント経由の回答だったときだけ記録される（`answerApproval` の' +
            '`#recordPermissionGrantIfConsented`。operator 経由の回答は記録されない——' +
            'operator の資格はクローンの器から読めるため、人間の証拠にならない）。' +
            '`revokedAt` が付いていない行だけが、クローン本セッションの Bash 呼び出しで自動的に' +
            '通る（`clone.ts` の `#onPreToolUse`）。並びは `grantedAt` 昇順。',
          responses: {
            200: jsonResponse(
              '許可の一覧。読めない行（型に合わない形で入っている許可）が1件でも在るときだけ ' +
                '`rowsUnreadable`（件数と id・不正な欄名。本文は載せない）が付く。読めない行しか無いと ' +
                '`grants` は空だが「許可が無い」とは限らない。id を `POST /permission-grants/unreadable/remove` に渡して消せる。',
              permissionGrantsResponseSchema,
            ),
          },
        }),
        async (c) => {
          const grants = await stores.permissionGrants.list();
          // 0件なら鍵ごと無い: 読めない行しか無いと `grants` は空で「許可が無い」に見える。本文は載せない（id と不正な欄名だけ）。
          const rowsUnreadable = toRowsUnreadable(await stores.permissionGrants.listUnreadable());
          return c.json(
            permissionGrantsResponseSchema.parse({
              grants,
              ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
            }),
          );
        },
      )

      .post(
        '/permission-grants/:id/revoke',
        describeRoute({
          tags: ['permission-grants'],
          summary: '許可を取り消す',
          description:
            '行は消さず `revokedAt` を立てる（`approval_withdraw` と同じ' +
            '「終端は別の状態であって削除ではない」思想）。**取り消しは次の Bash 呼び出しから' +
            '効く**——`#onPreToolUse` は呼び出しのたびにストアを引き直し、キャッシュしない。' +
            '既に取り消し済みでも 200（`revokedAt` は上書きしない）。運ぶ情報は無い（`{}` を送る）。',
          requestBody: emptyJsonPostRequestBody('許可を落とされないため'),
          responses: {
            200: jsonResponse('取り消した（既に取り消し済みでも 200）。', okResponseSchema),
            404: errorResponse('該当する許可が無い。'),
            409: errorResponse(
              '該当する許可の行は在るが、型に合わない形で入っていて読めない（居ないのとは' +
                '区別する。issue #2425）。取り消しはこの口ではできず、行は変わっていない。' +
                '読めない許可は「許可が無い」ものとして扱われる（通らない）。消すには ' +
                '`POST /permission-grants/unreadable/remove`（issue #2440）。',
            ),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        async (c) => {
          const id = c.req.param('id');
          // `get()` → `put({ ...grant, revokedAt })` にしない: lost update になる。`revoke` が排他区間の中で現在値を読み直すので、`#onPreToolUse` の `markUsed` 割り込みでも取り消しが消えない。読めない行は「無い」（404）ではなく 409 と言い分ける。
          let grant: Awaited<ReturnType<typeof stores.permissionGrants.revoke>>;
          // 日誌の書き分けのためだけに取り消す前の状態を読む: 取り消し自体はこの読みに依らない。読めない行は `get()` に現れず `null` になるが、下の `revoke` が 409 で止める。
          const revokedBefore = (await stores.permissionGrants.get(id))?.revokedAt !== undefined;
          const revokeAt = new Date().toISOString();
          try {
            grant = await stores.permissionGrants.revoke(id, revokeAt);
          } catch (error) {
            if (!(error instanceof UnreadablePermissionGrantError)) throw error;
            return c.json(
              {
                error:
                  `許可 ${error.id} は読めない形で入っている（消されたのでも、取り消されたのでもない）。` +
                  '取り消しはこの口ではできない。本文はここでは取れない。' +
                  '消すには `POST /permission-grants/unreadable/remove`（alteroid permission remove-unreadable <id>）を使う。',
              },
              409,
            );
          }
          if (grant === null) return c.json({ error: 'not found' as const }, 404);
          // 操作は毎回残し、出来事は重ねない: 既に取り消し済みへの取り消しは「取り消した」と書かず書き分ける（`revoke` は元の `revokedAt` を保つ）。並行した2つの取り消しで読み取りが両方「まだ」でも、`revokedAt` が今回の時刻でないことで後に着いた側が拾える。
          const alreadyRevoked = revokedBefore || grant.revokedAt !== revokeAt;
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: alreadyRevoked
                ? `許可の取り消しを求められたが、既に取り消し済みだった（revokedAt は変えていない）: ${grant.rule}`
                : `許可を取り消した: ${grant.rule}`,
              grounds: `${describeActor(c.get('principal'))}（POST /permission-grants/${id}/revoke）`,
            },
            '許可の取り消しの日誌',
            `id=${id}`,
          );
          // 委譲先へ配る（#4952）。載せない形の許可（`*` を含む prefix など。前方一致も載せる: #5435）・既に取り消し済みでは配らない: 一覧は変わらないため
          // 応答の前に配り終える: 「取り消した」が人間に返った後も委譲先で規則が効き続ける窓を、配れた runner については閉じるため。配れなくても取り消しは効いている（配れなかったことはサービスが日誌に残す）
          if (!alreadyRevoked && delegatedPermissionRuleOf(grant.rule) !== undefined) {
            await deps.permissionRules
              ?.pushAll(`許可 ${grant.id} が取り消された（POST /permission-grants/:id/revoke）`)
              .catch(() => undefined);
          }
          return c.json({ ok: true });
        },
      )

      // `:id` の下に置かない: 読めた行の id と名前空間が重なりうるので、別の語（`unreadable`）の下に置く。
      .post(
        '/permission-grants/unreadable/remove',
        ...unreadableRowsRemoveHandlers({
          stores,
          path: '/permission-grants/unreadable/remove',
          tag: 'permission-grants',
          summary: '読めない許可の行を、id を指して消す',
          description:
            '読めない（型に合わない形で入っている）許可の行だけを、id を指して消す。読める許可には' +
            '触れない。id が取れない行はこの口では消せない（`permission-grants.json` を手で直す）。' +
            '1つでも読めない行に無い id があれば何も消さない。消した id と件数を日誌に残す' +
            '（行の中身は残さない）。',
          notFoundDescription:
            '指した id のうち、読めない行に無いものがあった（何も消していない。日誌も書いていない。pg で日誌の後の再確認で倒れた回だけは、日誌に打ち消しの行を足す）。',
          subject: '許可の記録',
          noun: '許可',
          hint: '`GET /permission-grants` の `rowsUnreadable.rows[].id`（alteroid permission list）',
          remove: (ids, options) => stores.permissionGrants.removeUnreadable(ids, options),
        }),
      )
  );
}
