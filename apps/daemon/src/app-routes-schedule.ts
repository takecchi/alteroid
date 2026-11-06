import type { Stores } from '@alteroid/core';
import {
  ScheduleConflictError,
  RESERVED_SCHEDULE_KINDS,
  UnreadableScheduleError,
  describeUnreadableScheduleEdit,
  noteDroppedRecord,
  dropUnreadTimersOfKind,
  removeScheduleJournalFirst,
  scheduleReplaceEntry,
  scheduleKindSchema,
  SCHEDULE_EVERY_MINUTES_MAX_MESSAGE,
  scheduleSpecSchema,
  nonBlankString,
} from '@alteroid/core';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  errorResponseSchema,
  okResponseSchema,
  scheduleCreateResponseSchema,
  scheduleConflictResponseSchema,
  scheduleRemoveRequestSchema,
  scheduleListResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  jsonBody,
  appendJournalOrDrop,
  journalWriteFailedBody,
  kindOfError,
  humanActionOf,
  ifMatchField,
  deliberateClient,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  withWhere,
} from './app-shared.js';

const scheduleBody = z.object({
  kind: scheduleKindSchema,
  // 「空」は NUL を落とした後で、空白だけも空として見る（道具 `schedule_create` と同じ判定）: 落とす前の長さで見ると NUL だけの `request` が検査を抜け、ハンドラが日誌へ書いた後で 500 になる。空白だけは中身の無い依頼が毎回届く。
  request: nonBlankString,
  spec: scheduleSpecSchema,
  ifMatch: ifMatchField,
});

export function scheduleRoutes(ctx: AppContext, deps: AppDeps) {
  const { clone, stores } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      .get(
        '/schedule',
        describeRoute({
          tags: ['schedule'],
          summary: '定期ジョブの一覧と次の発火時刻',
          description:
            '行が読めない（版ずれ・手編集）継続中の依頼が在るときだけ、`unreadable`（kind が取れれば' +
            'kind と不正な欄名）が載る。**壊れた行であって、消された依頼ではない。**' +
            '0件なら鍵ごと無い（issue #2343）。',
          responses: {
            200: jsonResponse('定期ジョブの一覧。', scheduleListResponseSchema),
          },
        }),
        (c) => {
          // 0 件なら鍵ごと無い: 既存の呼び手の応答を1バイトも変えない。
          const unreadable = deps.scheduler?.unreadable() ?? [];
          return c.json(
            scheduleListResponseSchema.parse({
              entries: deps.scheduler?.list() ?? [],
              ...(unreadable.length > 0 ? { unreadable } : {}),
            }),
          );
        },
      )

      // スケジューラへ直接足さない: 真実はストア側にあり、直接足すとデーモンを再起動した瞬間に消える仕込みができる。
      .post(
        '/schedule',
        describeRoute({
          tags: ['schedule'],
          summary: '継続中の依頼を仕込む・直す',
          description:
            '「定期的に〜しておいて」をクローンの記憶任せにせず、時刻が来れば必ず届く形で置く。' +
            '同じ kind なら置き換わる（前回動いた時刻は保つ）。' +
            '任意の `ifMatch`（`GET /schedule` で読んだ時の `updatedAt`。無かったなら null）を付けると、' +
            '版が違うときは書かずに 409。省略は従来どおり後勝ち。' +
            '既存の kind を置き換えるときは、置き換える前に旧本文・旧周期を日誌（decision）へ残す' +
            '（書けなければ置き換えず 500）。応答の `replaced` が置換（true）か新規（false）かを言う。' +
            '真実はストア側にあり、' +
            'スケジューラはそれを読み直すだけなので、デーモンを作り直しても残る。' +
            // 一覧を数え直さず `RESERVED_SCHEDULE_KINDS` から導出する: この description は `openapi.json` へ焼かれるので、数え直すと生成物も同じ嘘を持つ。
            `既定の定期ジョブ（${RESERVED_SCHEDULE_KINDS.join(' / ')}）の名前は奪えない（→ 409）。`,
          responses: {
            200: jsonResponse(
              '仕込んだ。次の発火は `GET /schedule` で見える。`replaced` は既存の kind を置き換えたとき true。',
              scheduleCreateResponseSchema,
            ),
            400: errorResponse('本文が JSON として不正（kind の形・時刻の範囲もここで弾く）。'),
            409: {
              description:
                '次の3つ。(1) 既定の定期ジョブの名前（`{ error }` だけ）。(2) `ifMatch`（読んだ時の版 =' +
                ' `updatedAt`）が、いまの版と違う（読んでから書くまでの間に別の書き手が書いた、または' +
                '消した。`null` を送ったのに既に在る場合も）。**何も書いていない。** `current` にいまの' +
                '依頼を返す（消えていれば null）。見分けは `current` の鍵の有無。' +
                '(3) その kind の行が読めない形で入っている（版ずれ・手編集。`{ error }` だけ。`ifMatch` の' +
                '有無を問わない）。**何も書いていない。** `DELETE /schedule/{kind}` で外してから作り直す。',
              content: {
                'application/json': {
                  schema: resolver(z.union([scheduleConflictResponseSchema, errorResponseSchema])),
                },
              },
            },
          },
        }),
        jsonBody(scheduleBody, (where) => ({
          error:
            withWhere('kind/request/spec の形が不正', where) +
            // every の分数の断りは上限と代わりの書き方を伝える。値は混ぜない（固定の文だけ）。
            (where.split(', ').includes('spec.minutes')
              ? `（${SCHEDULE_EVERY_MINUTES_MAX_MESSAGE}）`
              : ''),
        })),
        async (c) => {
          const { kind, request, spec, ifMatch } = c.req.valid('json');
          if (RESERVED_SCHEDULE_KINDS.includes(kind)) {
            return c.json({ error: 'reserved kind' as const }, 409);
          }
          const now = new Date().toISOString();
          // 呼び手が `ifMatch` を渡さなかったとき、読んだ後に別の書き手が同じ kind を変えていたら読み直す回数（上限が無いと、書き換え続ける相手と無限に競る）
          const implicitAttempts = 3;
          let edited: Awaited<ReturnType<Stores['schedules']['editRequest']>>;
          for (let attempt = 1; ; attempt += 1) {
            // 読めない行は `null` のまま進める: `editRequest` が `UnreadableScheduleError` を投げ、下で 409 にする
            let previous: Awaited<ReturnType<Stores['schedules']['get']>>;
            try {
              previous = await stores.schedules.get(kind);
            } catch (error) {
              if (!(error instanceof UnreadableScheduleError)) throw error;
              previous = null;
            }
            // 能力を広げる口は日誌を先に書く: 書けなければ仕込まずに 500。置き換えるときは旧本文・旧周期を逐語で残す（置き換えると行から消える。道具 `schedule_create` と同じ `scheduleReplaceEntry`）。
            // 「仕込んだ」か「直した」かの最終の区別は `editRequest` の戻り値でしか分からないので、後で分かる分は2行目として best-effort で足す。
            await stores.journal.append(
              previous === null
                ? {
                    type: 'decision',
                    decision: `人間が定期の依頼を設定しようとしている: ${kind}: ${request}`,
                    grounds: '人間が直接 API から仕込んだ',
                  }
                : scheduleReplaceEntry({
                    kind,
                    previous,
                    next: { request, spec },
                    actor: '人間が',
                  }),
            );

            // 編集は `editRequest`、新規作成だけ `put`: `get()` して `put()` すると、その間に定期発火の `claimRun` が割り込んだ印を丸ごと消す lost update になる。`editRequest` は現在値を排他区間の中で読み直して引き継ぐ。
            // `ifMatch` が無いときは、いま読んだ行の版で書く: 日誌に残した旧本文と実際に上書きされる本文を同じものにするため（無いなら「無いときだけ作る」）。渡されたときは呼び手の版を優先する（意味は変えない）。
            const writeIfMatch = ifMatch !== undefined ? ifMatch : (previous?.updatedAt ?? null);
            try {
              edited = await stores.schedules.editRequest(kind, { request, spec }, now, {
                ifMatch: writeIfMatch,
              });
              if (edited === null) {
                // 「無いときだけ作る」をストアの排他の中で行う。
                await stores.schedules.put(
                  { kind, spec, request, createdAt: now, updatedAt: now },
                  { ifMatch: null },
                );
              }
              break;
            } catch (error) {
              // 黙って上書きしない: 書いていないので、先に積んだ行を打ち消す。
              if (error instanceof ScheduleConflictError) {
                await appendJournalOrDrop(
                  stores,
                  {
                    type: 'decision',
                    decision: `人間が定期の依頼を設定できなかった（読んだ後に変わっていた）: ${kind}: ${request}`,
                    grounds: '人間が直接 API から仕込もうとしたが、読んだ版と違うので書いていない',
                  },
                  '定期の依頼の打ち消しの日誌',
                  `kind=${kind}`,
                );
                if (ifMatch === undefined && attempt < implicitAttempts) continue;
                return c.json(
                  {
                    error: '継続中の依頼が読んだ後に変わっています（書き換えていません）' as const,
                    current: error.current,
                  },
                  409,
                );
              }
              if (error instanceof UnreadableScheduleError) {
                await appendJournalOrDrop(
                  stores,
                  {
                    type: 'decision',
                    decision: `人間が定期の依頼を設定できなかった（読めない形で入っている）: ${kind}: ${request}`,
                    grounds:
                      '人間が直接 API から仕込もうとしたが、その kind の行が読めないので書いていない',
                  },
                  '定期の依頼の打ち消しの日誌',
                  `kind=${kind}`,
                );
                return c.json({ error: describeUnreadableScheduleEdit(error) }, 409);
              }
              await appendJournalOrDrop(
                stores,
                {
                  type: 'decision',
                  decision: `人間が定期の依頼を設定できなかった: ${kind}: ${request}`,
                  grounds: '人間が直接 API から仕込もうとしたが、状態の変更が失敗した',
                },
                '定期の依頼の打ち消しの日誌',
                `kind=${kind}`,
              );
              throw error;
            }
          }
          // 仕込み・直しは効いているので、後で分かった区別は2行目として足す（落ちても 500 にしない。`appendJournalOrDrop`）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `人間が定期の依頼を${edited !== null ? '直した' : '仕込んだ'}: ${kind}: ${request}`,
              grounds: '人間が直接 API から仕込んだ',
            },
            '定期の依頼の日誌',
            `kind=${kind}`,
          );
          // 次の刻みを待たずに効かせる: 人間が仕込んだのに1分間存在しないのは嘘になる。
          await deps.scheduler?.refresh().catch(() => undefined);
          return c.json(
            scheduleCreateResponseSchema.parse({ ok: true, replaced: edited !== null }),
          );
        },
      )

      .delete(
        '/schedule/:kind',
        describeRoute({
          tags: ['schedule'],
          summary: '継続中の依頼を外す',
          description:
            '済んだ依頼・もう要らない依頼をここで外す。既定の定期ジョブは仕込みではないので' +
            'ここでは外せない（間隔と締め時刻はデーモンの設定である）。' +
            '本文の `ifMatch`（一覧で見た `updatedAt`）を渡すと、見た後にその依頼が書き換えられていたとき外さずに 409。' +
            '省けば今までどおり比べない（読めない行を外すときは省く）。',
          requestBody: {
            required: true,
            description:
              '`{}` か `{ "ifMatch": "<見た updatedAt>" }`。`DELETE` だが本文が必須なのは、' +
              '門番（`deliberateClient`）が `content-type: application/json` を要求することを' +
              'spec の機械可読部で表す手段がこれしか無いからである（`DELETE /managers/{id}` も' +
              '本文を要求する）。',
            content: { 'application/json': { schema: resolver(scheduleRemoveRequestSchema) } },
          },
          responses: {
            200: jsonResponse('外した。', okResponseSchema),
            400: errorResponse('本文の形が不正（`ifMatch` が空文字など）。外していない。'),
            404: errorResponse('その kind の継続中の依頼が無い。'),
            409: jsonResponse(
              '`ifMatch` がいまの依頼の版と違う（見た後に書き換えられた・読めない形になった）。外していない。' +
                '`current` はいまの依頼（読めないときは `null`）。',
              scheduleConflictResponseSchema,
            ),
            500: journalWriteFailedResponse(
              '外す前の日誌が書けなかったので外していない（`code` は `journal_write_failed`）。',
            ),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        async (c) => {
          const kind = c.req.param('kind');
          // `jsonBody` で検査しない: 本文は空でも `{}` でも通す約束（`noBodyPostRequestBody` の注記）で、本文を付けない呼び手（CLI の /unschedule）が居る。
          // 本文が在って `ifMatch` が在るときだけ読み、形が違えば外さずに 400
          const raw = await c.req.text();
          let ifMatch: string | undefined;
          if (raw.trim() !== '') {
            let parsedBody: unknown;
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              return c.json({ error: '外す依頼の入力の形が不正（外していない）' as const }, 400);
            }
            const checked = scheduleRemoveRequestSchema.safeParse(parsedBody);
            if (!checked.success) {
              return c.json(
                { error: '外す依頼の入力の形が不正（外していない）: ifMatch' as const },
                400,
              );
            }
            ifMatch = checked.data.ifMatch;
          }
          // 外した行の本文は行から消えるので、日誌を先に書いてから外す（`removeScheduleJournalFirst`）。書けなければ外さずに 500。
          // 先の行に humanAction を付けない: 印はクローンに「人間がこれを取り消した」と学ばせる行なので、効いた回だけに置く（下の2行目）。外せなかった回に印が残ると、届いていない操作を学ばせる。
          // 壊れた行は `get` が投げるので、helper が「読めない形で入っていた依頼」として扱って外せるようにしてある。
          const result = await removeScheduleJournalFirst(stores, kind, {
            ifMatch,
            buildEntry: (before) => ({
              type: 'decision',
              decision:
                before === 'unreadable'
                  ? // 本文を持たない: 読めなかった行を壊れた形のまま日誌へ書くと、読めない値を持ち回ることになる。
                    `人間が読めない形で入っていた依頼を外す: ${kind}`
                  : `人間が定期の依頼を外す: ${kind}: ${before.request}`,
              grounds: '人間が直接 API から外そうとしている',
            }),
          });
          if (result.kind === 'journal-failed') {
            noteDroppedRecord(
              '定期の依頼を外す日誌（外していない）',
              `kind=${kind}`,
              kindOfError(result.error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          if (result.kind === 'conflict') {
            return c.json(
              {
                error: '継続中の依頼が見た後に変わっています（外していません）' as const,
                current: result.current,
              },
              409,
            );
          }
          if (result.kind === 'not-found') return c.json({ error: 'not found' as const }, 404);
          const removed = result.removed;
          // 取り消した依頼の未読の起動は走らせない: 残すと依頼の無い kind として本文なしのターンが走る
          const timersCleared = await dropUnreadTimersOfKind(
            stores,
            { dropQueuedInboxEvents: (ids) => clone.dropQueuedInboxEvents(ids) },
            kind,
          );
          // 消しきれなかったら日誌の行に添える（#6544）: 外すこと自体は済んでいるので 200 のまま、取り消した依頼の起動が走りうることを残す
          const timersNote = timersCleared
            ? ''
            : '（ただし、この依頼の未読の起動を受信箱から消しきれなかった。取り消した依頼の起動が、本文なしのターンで走りうる）';
          // 外せた回だけ印つきの行を足す（先の行と中身が重なるのは、印のある行を効いた回だけに置くため）。外すこと自体は効いているので、落ちても 500 を返さない（`appendJournalOrDrop`）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision:
                (removed === 'unreadable'
                  ? `人間が読めない形で入っていた依頼を外した: ${kind}`
                  : `人間が定期の依頼を外した: ${kind}: ${removed.request}`) + timersNote,
              grounds: '人間が直接 API から外した',
              ...humanActionOf(c.get('principal'), 'schedule_remove', kind),
            },
            '定期の依頼を外した日誌',
            `kind=${kind}`,
          );
          await deps.scheduler?.refresh().catch(() => undefined);
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // 観測ではなく実行: ブラウザから叩けてはいけない。
      .post(
        '/schedule/:kind/run',
        describeRoute({
          tags: ['schedule'],
          summary: '定期ジョブを今すぐ起こす',
          description:
            'これは観測ではなく実行である。起こせばクローンのターンが走り、記憶に基づく委譲や' +
            '外部への操作の判断まで動く。予定はずらさない（余分に1回起こす）。',
          requestBody: emptyJsonPostRequestBody('自律ターンを起こされないため'),
          responses: {
            200: jsonResponse('起こした。', okResponseSchema),
            404: errorResponse('知らない kind。'),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        (c) => {
          const kind = c.req.param('kind');
          if (deps.scheduler?.run(kind) !== true)
            return c.json({ error: 'not found' as const }, 404);
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )
  );
}
