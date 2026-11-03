import { randomUUID } from 'node:crypto';
import type { Task, TaskPlacement, JournalEntryInput, Stores } from '@alteroid/core';
import {
  UnreadableTaskError,
  describeTaskPlacement,
  isTaskClosed,
  noteDroppedRecord,
  reasonOf,
  stripNul,
  TASK_TITLE_MAX,
} from '@alteroid/core';
import { nonBlankString } from '@alteroid/core';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  taskListResponseSchema,
  taskDetailResponseSchema,
  taskAddedResponseSchema,
  taskConflictResponseSchema,
  errorResponseSchema,
  okResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import {
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  invalidWith,
  REQUIRED_JSON_BODY,
  jsonBody,
  queryParams,
  appendJournalOrDrop,
  journalWriteFailedBody,
  humanRetractor,
  kindOfError,
  humanActionOf,
  nonNulString,
} from './app-shared.js';

// `z.coerce.boolean()` を使わない: `?includeClosed=false` が true になり、一覧が片付いたもので埋まる。
// `GET /tasks` は `includeClosed` だけを受ける: 並べ替えは器が持つ並び（store の position）が唯一で、窓や絞り込みは必要が出てから足す。
const tasksQuery = z.object({
  includeClosed: z.enum(['true', 'false']).default('false'),
});

// task の書く口の本文（#5469 P7c-1）。空白だけ・NUL だけは断る。
// title は道具 `task_add` と同じ一行（改行なし・TASK_TITLE_MAX 字まで）。
const taskTitleField = nonBlankString
  .refine((value) => stripNul(value).length <= TASK_TITLE_MAX)
  .refine((value) => !/[\r\n]/.test(value));
const taskPlacementBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('front') }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('before'), anchorId: z.string().min(1) }),
  z.object({ kind: z.literal('after'), anchorId: z.string().min(1) }),
]);

const taskAddBody = z.object({
  title: taskTitleField,
  body: nonBlankString,
  // 起点の会話。無ければ付けない: 嘘の出どころを埋めない。
  source: nonNulString.optional(),
  // 省くと既定の置き場所（`placeTask`。human 起点は開いている human 起点の最後の直後）
  placement: taskPlacementBody.optional(),
});

// 理由は必須: 否定する材料の無い閉じ方を受け付けない
const taskCloseBody = z.object({ status: z.enum(['done', 'cancelled']), reason: nonBlankString });

const taskReopenBody = z.object({ reason: nonBlankString });

const taskMoveBody = z.object({ placement: taskPlacementBody });

const taskEditBody = z
  .object({
    title: taskTitleField.optional(),
    body: nonBlankString.optional(),
    ifMatch: z.string().optional(),
  })
  .refine((value) => value.title !== undefined || value.body !== undefined);

const TASK_ID_NOT_FOUND_DESCRIPTION = 'その id は task に無い。';

// task の1行を読む。読めない行は例外にせず値で返す（無い 404 と読めない 409 を書き分けるため）
async function readTask(
  stores: Pick<Stores, 'tasks'>,
  id: string,
): Promise<
  { kind: 'found'; task: Task } | { kind: 'absent' } | { kind: 'unreadable'; reason: string }
> {
  try {
    const task = await stores.tasks.get(id);
    return task === null ? { kind: 'absent' } : { kind: 'found', task };
  } catch (error) {
    if (!(error instanceof UnreadableTaskError)) throw error;
    return { kind: 'unreadable', reason: reasonOf(error) };
  }
}

// 読めない行を書き直さずに 409 で断る本文（task の書き込み4口。`verb` は「〜いない」の前の動詞のて形: 閉じて・開き直して・動かして・直して）。
function unreadableTaskBody(reason: string, verb: string): { error: string } {
  return { error: `${reason}。読めない形のまま書き直さないので、${verb}いない。` };
}

// 閉じた task の記録を逐語で言う。開き直すと行から消える（`TaskStore.setStatus` の注）ので、日誌へ残す材料
function describeClosedTask(task: Task): string {
  return (
    `状態 ${task.status}、閉じた時刻 ${task.closedAt ?? '記録なし'}、主体 ${task.closedBy ?? '記録なし'}、` +
    `理由「${task.closedReason ?? '理由の記録なし'}」`
  );
}

// 日誌を先に書く（#5243 と同じ作法）。書けなければ記録を残して false を返し、呼び出し側は状態を変えずに 500 を返す。
async function appendJournalFirst(
  stores: Pick<Stores, 'journal'>,
  entry: JournalEntryInput,
  what: string,
  detail: string,
): Promise<boolean> {
  try {
    await stores.journal.append(entry);
    return true;
  } catch (error) {
    noteDroppedRecord(what, detail, kindOfError(error));
    return false;
  }
}

// 開いている行の並びの何番目か（1始まり）。日誌に「前と後」を残すためだけに使う
async function openPositionOf(stores: Pick<Stores, 'tasks'>, id: string): Promise<string> {
  const { entries } = await stores.tasks.list();
  const index = entries.findIndex((entry) => entry.id === id);
  return index < 0
    ? '不明'
    : `${String(index + 1)}番目（開いている ${String(entries.length)} 件のうち）`;
}

export function tasksRoutes(ctx: AppContext) {
  const { stores } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 読むだけ（書く口は P2 では HTTP に出さない）: 書く経路を増やすと「CLI でできないこと」「クローンの道具と違う規則」が生まれる前に、読み口で並びの見え方を確かめたいため（#5469）。
      // 資格は `authenticate` だけ。
      .get(
        '/tasks',
        describeRoute({
          tags: ['tasks'],
          summary: 'task（順序と状態を持つ待ち行列）の一覧',
          description:
            'クローンの `task_list` と同じものを人間の側から読む。**`entries` の並びが優先順**（先頭が先にやるもの）で、' +
            '数値の優先度・締切は持たない。既定は開いている行（`queued` / `waiting` / `needs_decision`）だけで、' +
            '`includeClosed=true` を付けると閉じた行（`done` / `cancelled`）が後ろに新しい順で続く。' +
            '本文は切らずに返す。`unreadable` は読めなかった行で、「無い」でも「終わった」でもない第3の状態（0件でも欄は返る）。',
          responses: {
            200: jsonResponse('task の一覧。', taskListResponseSchema),
            400: errorResponse('クエリが不正（`includeClosed` は `true` / `false` だけ）。'),
          },
        }),
        queryParams(tasksQuery),
        async (c) => {
          const { includeClosed } = c.req.valid('query');
          const { entries, unreadable } = await stores.tasks.list(
            includeClosed === 'true' ? { includeClosed: true } : undefined,
          );
          return c.json(taskListResponseSchema.parse({ entries, unreadable }));
        },
      )

      // 人間が task を書く口（#5469 P7c-1）。台帳の書く口は撤去済みで、人間が仕事を積む・直す・閉じる口は task だけが持つ。
      .get(
        '/tasks/:id',
        describeRoute({
          tags: ['tasks'],
          summary: 'task を1件、全文で読む',
          description:
            'task の1行を、`title`・`body` を切らずに返す（`GET /tasks` と同じ形の行）。並びの位置は一覧の `entries` の順で見る。',
          responses: {
            200: jsonResponse('task の1行。', taskDetailResponseSchema),
            404: errorResponse('該当する行が無い。'),
            409: errorResponse('行は在るが、読めない形で入っている（消されたのではない）。'),
          },
        }),
        async (c) => {
          const read = await readTask(stores, c.req.param('id'));
          if (read.kind === 'unreadable') return c.json({ error: read.reason }, 409);
          if (read.kind === 'absent') return c.json({ error: 'not found' as const }, 404);
          return c.json(taskDetailResponseSchema.parse({ entry: read.task }));
        },
      )

      // 積むだけでクローンのターンは起こさない: 起点を増やすと同じことを2つの経路で起こせる状態になる。積む・編集には humanAction を付けない（architecture.md の humanAction の対象）。
      .post(
        '/tasks',
        describeRoute({
          tags: ['tasks'],
          summary: 'task を積む',
          description:
            'クローンの `task_add` と同じものを人間の手から。**積むだけで、クローンのターンは起こさない**（いま考えさせたいなら `POST /chat` か `POST /events`）。' +
            '`origin` は `human` で固定、id と時刻はここで振る。`placement` を省くと既定の置き場所（開いている human 起点の最後の直後）で、' +
            '指すなら `{ kind: front | back | before | after, anchorId? }`（before / after は開いている task の id が要る）。' +
            '`source` を渡すと起点の会話の id として `source` と `originConversationId` の両方に入る（無ければ付けない）。',
          responses: {
            200: jsonResponse(
              '積んだ。返る id が閉じる・動かすときの宛先になる。',
              taskAddedResponseSchema,
            ),
            400: errorResponse(
              '本文が JSON として不正（`title` は一行・200字まで・空白だけは不可、`body` は空にできない）、または `placement` の基準が開いている task に無い（何も積んでいない）。',
            ),
          },
        }),
        jsonBody(taskAddBody, invalidWith('body の形が不正')),
        async (c) => {
          const { title, body, source, placement } = c.req.valid('json');
          const now = new Date().toISOString();
          // `origin` は本文から取らない: 人間に選ばせると `self` を名乗れてしまい、「人間との約束か自分で思い立ったことか」をクローンが区別する手立てが消える。
          const entry: Task = {
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
            status: 'queued',
            origin: 'human',
            ...(source === undefined ? {} : { source, originConversationId: source }),
            title,
            body,
          };
          const taskPlacement: TaskPlacement | undefined = placement;
          const added = await stores.tasks.add(entry, taskPlacement);
          if (added.kind === 'anchor-not-found') {
            return c.json(
              { error: `placement の anchorId は開いている task に無い（何も積んでいない）` },
              400,
            );
          }
          if (added.kind === 'existed') {
            // 新しい id なので来ない。来たら黙って「積んだ」と言わない
            throw new Error('新しく振った task の id が既に在った');
          }
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              target: { kind: 'task', id: entry.id },
              decision: `人間が task を積んだ（${entry.id}）: ${title}`,
              grounds: `人間が直接 API から積んだ。置き場所: ${describeTaskPlacement(taskPlacement)}。本文: ${body}`,
            },
            'task を積んだ日誌',
            `id=${entry.id}`,
          );
          return c.json(taskAddedResponseSchema.parse({ ok: true, id: entry.id }));
        },
      )

      // 日誌を先に書き、書けなければ閉じずに 500。先の行に humanAction を付けない: 印は効いた後の行だけが持つ。閉じられなかった操作を、クローンに「人間がした」と学ばせないため。
      // 先に読んで、既に断ると分かる回（無い・読めない・既に閉じている）は日誌を書かずに返す。読んだ後に割り込まれた回は `setStatus` の結果（`unchanged` / `rejected` / `not-found`）で判定し、先の行を打ち消す。
      .post(
        '/tasks/:id/close',
        describeRoute({
          tags: ['tasks'],
          summary: 'task を閉じる（done か cancelled）',
          description:
            'クローンの `task_set_status` で done / cancelled にするのと同じものを人間の手から。`status` は `done`（終わった）か `cancelled`（取りやめた）、`reason` は必須で、' +
            '人間はこれを読んで後から否定する。`closedBy` は `human`。行は消さない（閉じた行は `GET /tasks?includeClosed=true` で見える）。' +
            '日誌を先に書き、書けなければ閉じずに 500 を返す。効いた後に、人間の操作の印（`humanAction.kind = task_close`）を持つ行を足す。',
          responses: {
            200: jsonResponse('閉じた。', okResponseSchema),
            400: errorResponse(
              '本文が JSON として不正（`status` は done か cancelled、`reason` は空にできない）。',
            ),
            404: errorResponse(TASK_ID_NOT_FOUND_DESCRIPTION),
            409: errorResponse(
              '既に閉じている（いつ・どう閉じたかを本文に入れて返す。done と cancelled の付け替えもここで断る）。行が読めない形で入っている（書き直さない）。' +
                'または閉じる直前に状態が変わって閉じられなかった。',
            ),
            500: journalWriteFailedResponse('閉じる前の日誌が書けなかった（**閉じていない**）。'),
          },
        }),
        jsonBody(taskCloseBody, invalidWith('status / reason の形が不正')),
        async (c) => {
          const id = c.req.param('id');
          const { status, reason } = c.req.valid('json');
          const retract = humanRetractor(stores, {
            operation: 'task を閉じる',
            subject: `${id} を閉じる操作`,
            what: 'task を閉じる日誌の打ち消し',
            detail: `id=${id}`,
          });
          const read = await readTask(stores, id);
          if (read.kind === 'unreadable') {
            return c.json(unreadableTaskBody(read.reason, '閉じて'), 409);
          }
          if (read.kind === 'absent') return c.json({ error: 'not found' as const }, 404);
          if (isTaskClosed(read.task.status)) {
            return c.json(
              {
                error: `${id} は既に閉じている（${describeClosedTask(read.task)}）。何もしていない`,
              },
              409,
            );
          }
          const label = status === 'done' ? '終わった' : '取りやめた';
          const entryBefore: JournalEntryInput = {
            type: 'decision',
            target: { kind: 'task', id },
            decision: `人間が task を ${status}（${label}）にする（${id}）: ${reason}`,
            grounds: '人間が直接 API から閉じようとしている',
          };
          const entryAfter: JournalEntryInput = {
            type: 'decision',
            target: { kind: 'task', id },
            decision: `人間が task を ${status}（${label}）にした（${id}）: ${reason}`,
            grounds: '人間が直接 API から閉じた',
            ...humanActionOf(c.get('principal'), 'task_close', id),
          };
          if (
            !(await appendJournalFirst(
              stores,
              entryBefore,
              'task を閉じる日誌（閉じていない）',
              `id=${id}`,
            ))
          ) {
            return c.json(journalWriteFailedBody(), 500);
          }
          let result;
          try {
            result = await stores.tasks.setStatus(id, status, {
              reason,
              by: 'human',
              at: new Date().toISOString(),
            });
          } catch (error) {
            await retract('task の閉じる操作が失敗した');
            if (error instanceof UnreadableTaskError) {
              return c.json(unreadableTaskBody(reasonOf(error), '閉じて'), 409);
            }
            throw error;
          }
          if (result.kind !== 'changed') {
            await retract(
              '閉じる直前に行が無くなっていた・既にその状態だった・遷移が許されなかった',
            );
            if (result.kind === 'not-found') return c.json({ error: 'not found' as const }, 404);
            return c.json(
              {
                error:
                  result.kind === 'unchanged'
                    ? `${id} は既に ${status} だった。何もしていない`
                    : `${id} は既に ${result.from} で、${result.to} へは付け替えられない。何もしていない`,
              },
              409,
            );
          }
          // 閉じること自体は効いているので、日誌への追記だけが落ちても 500 を返さない
          await appendJournalOrDrop(stores, entryAfter, 'task を閉じた日誌', `id=${id}`);
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // 日誌を先に書く: 開き直すと閉じた時刻・主体・理由が行から消える（`TaskStore.setStatus` の注）ので、日誌が落ちたまま外すと「誰がいつ何と言って閉じたか」が二度と読めない。
      // 日誌へ残す「開き直す前の記録」は、`setStatus` が返す `before`（書き換える前の行）を逐語で使う。先に読んだ版は、割り込まれると食い違いうるため。
      .post(
        '/tasks/:id/reopen',
        describeRoute({
          tags: ['tasks'],
          summary: '閉じた task を queued へ開き直す',
          description:
            '閉じた task（done / cancelled）を名指しして `queued` へ戻す。作成時刻・起点・本文はそのままで、`closedAt` / `closedReason` / `closedBy` が外れ、' +
            '開いている human 起点の最後の直後（既定の置き場所）に並び直す。`reason` は必須で、開き直す前の閉じた記録とともに日誌（`decision`）へ逐語で残る。' +
            '日誌を先に書き、書けなければ開き直さずに 500。効いた後に、人間の操作の印（`humanAction.kind = task_reopen`）を持つ行を足す。',
          responses: {
            200: jsonResponse('開き直した。開いている一覧に戻る。', taskDetailResponseSchema),
            400: errorResponse('本文が JSON として不正（`reason` は空にできない）。'),
            404: errorResponse(TASK_ID_NOT_FOUND_DESCRIPTION),
            409: errorResponse(
              'まだ閉じていない（何もしない）。行が読めない形で入っている（書き直さない）。または開き直す直前に状態が変わった。',
            ),
            500: journalWriteFailedResponse(
              '日誌が書けなかった（**開き直していない**。行は閉じたまま）。',
            ),
          },
        }),
        jsonBody(taskReopenBody, invalidWith('reason の形が不正')),
        async (c) => {
          const id = c.req.param('id');
          const { reason } = c.req.valid('json');
          const retract = humanRetractor(stores, {
            operation: '閉じた task を開き直す',
            subject: `${id} を開き直す操作`,
            what: '閉じた task を開き直す日誌の打ち消し',
            detail: `id=${id}`,
          });
          const read = await readTask(stores, id);
          if (read.kind === 'unreadable') {
            return c.json(unreadableTaskBody(read.reason, '開き直して'), 409);
          }
          if (read.kind === 'absent') return c.json({ error: 'not found' as const }, 404);
          if (!isTaskClosed(read.task.status)) {
            return c.json(
              { error: `${id} は閉じていない（${read.task.status}）。何もしていない` },
              409,
            );
          }
          const entryBefore: JournalEntryInput = {
            type: 'decision',
            target: { kind: 'task', id },
            decision: `人間が閉じた task を開き直す（${id}）: ${reason}`,
            grounds: `人間が直接 API から開き直そうとしている。開き直す前の記録: ${describeClosedTask(read.task)}`,
          };
          if (
            !(await appendJournalFirst(
              stores,
              entryBefore,
              '閉じた task を開き直す日誌（開き直していない）',
              `id=${id}`,
            ))
          ) {
            return c.json(journalWriteFailedBody(), 500);
          }
          let result;
          try {
            result = await stores.tasks.setStatus(id, 'queued', {
              by: 'human',
              at: new Date().toISOString(),
            });
          } catch (error) {
            await retract('task の開き直しが失敗した');
            if (error instanceof UnreadableTaskError) {
              return c.json(unreadableTaskBody(reasonOf(error), '開き直して'), 409);
            }
            throw error;
          }
          if (result.kind !== 'changed') {
            await retract('開き直す直前に行が無くなっていた・既に閉じていなかった');
            if (result.kind === 'not-found') return c.json({ error: 'not found' as const }, 404);
            return c.json({ error: `${id} は閉じていない。何もしていない` }, 409);
          }
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              target: { kind: 'task', id },
              decision: `人間が閉じた task を開き直した（${id}）: ${reason}`,
              grounds: `人間が直接 API から開き直した。開き直す前の記録: ${describeClosedTask(result.before)}`,
              ...humanActionOf(c.get('principal'), 'task_reopen', id),
            },
            '閉じた task を開き直した日誌',
            `id=${id}`,
          );
          return c.json(taskDetailResponseSchema.parse({ entry: result.task }));
        },
      )

      // 並べ替えは情報を消さないが、「人間が先頭へ動かした」をクローンが次のターンで知る必要がある（task_move の印）ので、日誌は task の close と同じ順（先に書き、動かせなければ打ち消す）。
      .post(
        '/tasks/:id/move',
        describeRoute({
          tags: ['tasks'],
          summary: '開いている task の並びを変える',
          description:
            '開いている task を `placement`（`{ kind: front | back | before | after, anchorId? }`。before / after は開いている別の task の id）へ動かす。先頭が先にやるもの。' +
            '閉じた task は並びから外れているので動かせない（開き直すなら `POST /tasks/{id}/reopen`）。優先度・締切の数値は持たない。' +
            '日誌を先に書き、動かせなければ打ち消す。効いた後に、人間の操作の印（`humanAction.kind = task_move`）を持つ行を足す。',
          responses: {
            200: jsonResponse('動かした。', okResponseSchema),
            400: errorResponse(
              '本文が JSON として不正、または基準（`anchorId`）が開いている task に無い・自分自身を基準にした（何も動かしていない）。',
            ),
            404: errorResponse(TASK_ID_NOT_FOUND_DESCRIPTION),
            409: errorResponse('閉じていて動かせない。行が読めない形で入っている。'),
            500: journalWriteFailedResponse('動かす前の日誌が書けなかった（**動かしていない**）。'),
          },
        }),
        jsonBody(taskMoveBody, invalidWith('placement の形が不正')),
        async (c) => {
          const id = c.req.param('id');
          const { placement } = c.req.valid('json');
          const retract = humanRetractor(stores, {
            operation: 'task を並べ替える',
            subject: `${id} を動かす操作`,
            what: 'task を並べ替える日誌の打ち消し',
            detail: `id=${id}`,
          });
          const read = await readTask(stores, id);
          if (read.kind === 'unreadable') {
            return c.json(unreadableTaskBody(read.reason, '動かして'), 409);
          }
          if (read.kind === 'absent') return c.json({ error: 'not found' as const }, 404);
          if (isTaskClosed(read.task.status)) {
            return c.json(
              { error: `${id} は閉じている（${read.task.status}）ので動かせない。何もしていない` },
              409,
            );
          }
          const positionBefore = await openPositionOf(stores, id);
          const entryBefore: JournalEntryInput = {
            type: 'decision',
            target: { kind: 'task', id },
            decision: `人間が task を並べ替える（${id}）: ${read.task.title} を ${describeTaskPlacement(placement)} へ`,
            grounds: '人間が直接 API から並べ替えようとしている',
          };
          if (
            !(await appendJournalFirst(
              stores,
              entryBefore,
              'task を並べ替える日誌（動かしていない）',
              `id=${id}`,
            ))
          ) {
            return c.json(journalWriteFailedBody(), 500);
          }
          let result;
          try {
            result = await stores.tasks.move(id, placement);
          } catch (error) {
            await retract('task の並べ替えが失敗した');
            if (error instanceof UnreadableTaskError) {
              return c.json(unreadableTaskBody(reasonOf(error), '動かして'), 409);
            }
            throw error;
          }
          if (result.kind !== 'moved') {
            await retract(`動かせなかった（${result.kind}）`);
            if (result.kind === 'not-found') return c.json({ error: 'not found' as const }, 404);
            if (result.kind === 'closed') {
              return c.json({ error: `${id} は閉じていて動かせない。何もしていない` }, 409);
            }
            return c.json(
              {
                error:
                  result.kind === 'anchor-is-self'
                    ? 'placement の anchorId に自分自身は指せない（何も動かしていない）'
                    : 'placement の anchorId は開いている task に無い（何も動かしていない）',
              },
              400,
            );
          }
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              target: { kind: 'task', id },
              decision: `人間が task を並べ替えた（${id}）: ${read.task.title} を ${describeTaskPlacement(placement)} へ`,
              grounds: `人間が直接 API から並べ替えた。並び: ${positionBefore} → ${await openPositionOf(stores, id)}`,
              ...humanActionOf(c.get('principal'), 'task_move', id),
            },
            'task を並べ替えた日誌',
            `id=${id}`,
          );
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // 編集できるのは `origin` が `human` かつ未了の行の `title` / `body` だけ: クローンやマネージャーが立てた行を人間が静かに書き換えると、クローンが過去の自分を追えなくなる。
      // 編集の前の本文は行に残らないので、日誌へ逐語で残す。日誌を先に書き、書けなければ書き直さず 500。台帳の編集と同じく humanAction は付けない。
      .patch(
        '/tasks/:id',
        describeRoute({
          tags: ['tasks'],
          summary: 'task の title / body を後から直す',
          requestBody: REQUIRED_JSON_BODY,
          description:
            '編集できるのは `origin` が `human` でまだ閉じていない行の `title` と `body`（どちらか1つ以上）だけ。' +
            'クローン（`self`）やマネージャー（`manager`）・外部（`external`）が立てた行は人間からは直せない。状態・並び・起点・閉じた記録は変わらない。' +
            '編集の前後の本文は日誌（`decision`）へ逐語で残る。日誌を先に書き、書けなければ書き直さずに 500。' +
            '任意の `ifMatch`（`GET /tasks` で読んだ行の `editedAt ?? createdAt`）を付けると、版が違うときは書かずに 409。省略は後勝ち。',
          responses: {
            200: jsonResponse('直した。', okResponseSchema),
            400: errorResponse(
              '本文が JSON として不正（`title` は一行・200字まで・空白だけは不可、`body` は空にできない、どちらも無いのも不可）。',
            ),
            403: errorResponse(
              'origin が human ではない——クローン・マネージャー・外部が立てた行は人間からは直せない。',
            ),
            404: errorResponse(TASK_ID_NOT_FOUND_DESCRIPTION),
            409: {
              description:
                '次の3つ。(1) 既に閉じている。(2) 行が読めない形で入っている（書き直さない）。(3) `ifMatch` がいまの版と違う（何も書いていない。`current` にいまの行を返す。(3) だけが `current` の鍵を持つ）。',
              content: {
                'application/json': {
                  schema: resolver(z.union([taskConflictResponseSchema, errorResponseSchema])),
                },
              },
            },
            500: journalWriteFailedResponse(
              '日誌が書けなかった（**書き直していない**。行の本文は元のまま）。',
            ),
          },
        }),
        jsonBody(taskEditBody, invalidWith('title / body の形が不正')),
        async (c) => {
          const id = c.req.param('id');
          const { title, body, ifMatch } = c.req.valid('json');
          const retract = humanRetractor(stores, {
            operation: 'task を直す',
            subject: `${id} の編集`,
            what: 'task の編集の日誌の打ち消し',
            detail: `id=${id}`,
          });
          const read = await readTask(stores, id);
          if (read.kind === 'unreadable') {
            return c.json(unreadableTaskBody(read.reason, '直して'), 409);
          }
          if (read.kind === 'absent') return c.json({ error: 'not found' as const }, 404);
          const existing = read.task;
          if (existing.origin !== 'human') {
            return c.json(
              {
                error:
                  `${id} は origin:'${existing.origin}' で、クローンやマネージャーなどが立てた行は人間からは直せない` +
                  (existing.origin === 'self'
                    ? '（チャットでクローンに頼めば、クローンの task の道具で直せる）'
                    : ''),
              },
              403,
            );
          }
          if (isTaskClosed(existing.status)) {
            return c.json(
              { error: `${id} は既に閉じている（${describeClosedTask(existing)}）。直せない` },
              409,
            );
          }
          const changes = [
            ...(title === undefined
              ? []
              : [`title: 編集前「${existing.title}」→ 編集後「${title}」`]),
            ...(body === undefined ? [] : [`body: 編集前「${existing.body}」→ 編集後「${body}」`]),
          ].join(' / ');
          const entry: JournalEntryInput = {
            type: 'decision',
            target: { kind: 'task', id },
            decision: `人間が task を直した（${id}）: ${changes}`,
            grounds: '人間が直接 API から編集した',
          };
          if (
            !(await appendJournalFirst(
              stores,
              entry,
              'task の編集の日誌（書き直していない）',
              `id=${id}`,
            ))
          ) {
            return c.json(journalWriteFailedBody(), 500);
          }
          let result;
          try {
            result = await stores.tasks.edit(
              id,
              {
                ...(title === undefined ? {} : { title }),
                ...(body === undefined ? {} : { body }),
              },
              { at: new Date().toISOString(), ...(ifMatch === undefined ? {} : { ifMatch }) },
            );
          } catch (error) {
            await retract('task の書き直しが失敗した');
            if (error instanceof UnreadableTaskError) {
              return c.json(unreadableTaskBody(reasonOf(error), '直して'), 409);
            }
            throw error;
          }
          if (result.kind === 'edited') return c.json(okResponseSchema.parse({ ok: true }));
          await retract('書く直前に行が無くなっていた・閉じていた・読んだ版と変わっていた');
          if (result.kind === 'conflict') {
            return c.json(
              {
                error: 'task が読んだ後に変わっています（書き換えていません）' as const,
                current: result.current,
              },
              409,
            );
          }
          if (result.kind === 'closed') {
            return c.json({ error: `${id} は既に閉じている。直せない` }, 409);
          }
          return c.json({ error: 'not found' as const }, 404);
        },
      )
  );
}
