import type { JournalEntryInput } from '@alteroid/core';
import {
  type Practice,
  PracticeConflictError,
  UnreadablePracticeError,
  practiceKindSchema,
  practiceSlugSchema,
  practiceVersion,
  practiceVersionMatches,
  noteDroppedRecord,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  practiceDeleteResponseSchema,
  practiceListResponseSchema,
  practiceConflictResponseSchema,
  practiceReadResponseSchema,
  practiceWriteResponseSchema,
  practiceVersionListResponseSchema,
  practiceVersionReadResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import {
  ifMatchField,
  ifMatchDeleteQuery,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  invalidWith,
  jsonBody,
  queryParams,
  appendJournalOrDrop,
  journalWriteFailedBody,
  humanRetractor,
  kindOfError,
  humanActionOf,
} from './app-shared.js';

// 記憶・やり方の 409 の本文の組み立て（検査の順序は route ごとに違うので寄せない）。`error` は `as const` のリテラルのまま返す: 文が `string` に広がると `hc` の応答の型が変わる。
const PRACTICE_CONFLICT_ERROR = {
  write: 'やり方が読んだ後に変わっています（書き換えていません）',
  remove: 'やり方が読んだ後に変わっています（消していません）',
} as const;
const practiceCurrent = (practice: Practice) => ({
  practice,
  version: practiceVersion(practice),
});
const practiceConflictBody = <Op extends keyof typeof PRACTICE_CONFLICT_ERROR>(
  current: Practice | null,
  op: Op,
) => ({
  error: PRACTICE_CONFLICT_ERROR[op],
  current: current === null ? null : practiceCurrent(current),
});
// `kind` に列挙を課さない: 道具（`practice_write`）と HTTP とで書ける種類が食い違う（`practiceKindSchema` の doc）。`title` も core 側に制約が無いので足さない。
const practiceBody = z.object({
  kind: practiceKindSchema,
  title: z.string(),
  content: z.string(),
  ifMatch: ifMatchField,
});

export function practicesRoutes(ctx: AppContext) {
  const { stores } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // `apply` / `enforce` に当たる経路を足さない: 「このやり方に従え」という操作はどの入口にも存在しない（`docs/north_star.md`）。やり方は読む素材で、従うかはそのときのクローンが決める。
      // 日誌は `practice_write` / `practice_remove`（クローンの道具）と同じ `type: 'decision'` に揃える: 揃えないと同じ操作が人間経由かクローン経由かで日誌の型が変わる。
      .get(
        '/practices',
        describeRoute({
          tags: ['practices'],
          summary: '仕事のやり方の一覧',
          description:
            '仕事のやり方（PracticeStore）の一覧。本文は含まない（メタ情報だけ）。' +
            '**読めない行が無いのにやり方が1件も無いのは正常な状態である**——やり方が書かれていない' +
            '仕事も普通に進む。行が読めない（版ずれ・手編集）やり方が在るときだけ、`unreadable`' +
            '（slug が取れれば slug と不正な欄名）が載る。**壊れた行であって、消されたやり方ではない。**' +
            '0件なら鍵ごと無い（issue #2346）。',
          responses: {
            200: jsonResponse('やり方のメタ情報一覧（slug の昇順）。', practiceListResponseSchema),
          },
        }),
        async (c) => {
          // 0 件なら鍵ごと無い: 既存の呼び手の応答を1バイトも変えない。
          const { entries, unreadable } = await stores.practices.list();
          return c.json({
            practices: entries,
            ...(unreadable.length > 0 ? { unreadable } : {}),
          });
        },
      )

      .get(
        '/practices/:slug',
        describeRoute({
          tags: ['practices'],
          summary: 'やり方を1つ読む',
          responses: {
            200: jsonResponse('やり方（本文まで）。', practiceReadResponseSchema),
            400: errorResponse('やり方のスラッグが不正。'),
            404: errorResponse('該当するやり方が無い。'),
            409: errorResponse(
              '該当する行は在るが、型に合わない形で入っていて読めない（消されたのとは区別する。' +
                'issue #2011）。' +
                'PUT /practices/:slug で書き直すか、DELETE /practices/:slug で外せる。',
            ),
          },
        }),
        async (c) => {
          // `PUT`/`DELETE` と同じ門: ここが無いと不正なスラッグが store の `read()` へ渡って 404 になり、応答形が `PUT`/`DELETE` と違う。
          const slug = c.req.param('slug');
          if (!practiceSlugSchema.safeParse(slug).success) {
            return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
          }
          // 読めない行は素の 500（`onError` 任せ）にせず、何が起きたかが分かる 409 にする。
          let practice: Practice | null;
          try {
            practice = await stores.practices.read(slug);
          } catch (error) {
            if (!(error instanceof UnreadablePracticeError)) throw error;
            return c.json(
              {
                error: `やり方 ${slug} は読めない形で入っている（消されたのではない）。本文はここでは取れない。`,
              },
              409,
            );
          }
          if (!practice) return c.json({ error: 'not found' as const }, 404);
          return c.json({ practice, version: practiceVersion(practice) });
        },
      )

      .put(
        '/practices/:slug',
        describeRoute({
          tags: ['practices'],
          summary: 'やり方を全文置換で書く（無ければ作る）',
          description:
            '人間が API からやり方を書き換える口。`kind` は仕事の種類の自由文字列（列挙ではない——' +
            '`practiceKindSchema` の doc）。書き換えは日誌に残る（`type: decision`）。',
          responses: {
            200: jsonResponse('書き換え後のやり方。', practiceWriteResponseSchema),
            400: errorResponse('やり方のスラッグが不正、または本文が JSON として不正。'),
            409: jsonResponse(
              '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから書くまでの間に別の書き手が' +
                '書いた、または消した）。**何も書いていない**（版の履歴にも足していない）。' +
                '`current` にいまの版を返す。',
              practiceConflictResponseSchema,
            ),
            500: journalWriteFailedResponse(
              '既に在るやり方を書き直す前の日誌が書けなかった（**書き直していない**）。' +
                '新しく置く回は日誌を後に書くので、これを返さない。',
            ),
          },
        }),
        jsonBody(practiceBody, invalidWith('やり方の本文の形が不正')),
        async (c) => {
          const slug = c.req.param('slug');
          if (!practiceSlugSchema.safeParse(slug).success) {
            return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
          }
          const { kind, title, content, ifMatch } = c.req.valid('json');
          // `UnreadablePracticeError` を捕まえて先へ進む: 投げっぱなしにすると PUT がここで落ち、壊れた行を書き直す唯一の回復手段が塞がる。
          let before: Practice | null;
          let beforeWasUnreadable = false;
          try {
            before = await stores.practices.read(slug);
          } catch (error) {
            if (!(error instanceof UnreadablePracticeError)) throw error;
            before = null;
            beforeWasUnreadable = true;
          }
          // 既に在る行（読めない形の行を含む）の書き直しだけが、日誌を先に書く対象（#5243）。新しく置く回は取り消しでも書き換えでもないので、今までどおり書いた後に残す。
          const rewriting = before !== null || beforeWasUnreadable;
          // 読んだ版が既に食い違っていれば、日誌を書く前に 409 で返す（書かないので書く跡が無い）。読めない行は版が比べられないので、store の排他の中の判定に任せる。
          if (!beforeWasUnreadable && !practiceVersionMatches(before, ifMatch)) {
            return c.json(practiceConflictBody(before, 'write'), 409);
          }
          const entryAfter: JournalEntryInput = {
            type: 'decision',
            decision: beforeWasUnreadable
              ? `読めない形で入っていたやり方 ${slug}（${kind}）を書き直した: ${title}`
              : `やり方 ${slug}（${kind}）を${before === null ? '作った' : '書き直した'}: ${title}`,
            grounds: beforeWasUnreadable
              ? '人間が直接 API から、読めない形で入っていたやり方を書き直した（全文置換。' +
                '前の本文は読めなかったため分からない）'
              : before === null
                ? '人間が直接 API から新しいやり方を器に置いた'
                : '人間が直接 API からやり方を書き直した（全文置換。前の本文は' +
                  'GET /practices/:slug/versions の版の履歴に残る）',
            target: { kind: 'practice', slug },
            // 新しく置いた回には付けない: 取り消しでも書き換えでもなく、直しの合図として薄いため
            ...(rewriting ? humanActionOf(c.get('principal'), 'practice_write', slug) : {}),
          };
          if (rewriting) {
            // 日誌を先に書き、書けなければ書き直さずに 500（#5243）。先の行に humanAction を付けない: 印は効いた後の行（下）だけが持つ。書き直せなかった操作を、クローンに「人間がした」と学ばせないため。
            // 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない。
            const entryBefore: JournalEntryInput = {
              type: 'decision',
              decision: beforeWasUnreadable
                ? `人間が読めない形で入っていたやり方 ${slug}（${kind}）を書き直す: ${title}`
                : `人間がやり方 ${slug}（${kind}）を書き直す: ${title}`,
              grounds: '人間が直接 API から書き直そうとしている',
            };
            try {
              await stores.journal.append(entryBefore);
            } catch (error) {
              noteDroppedRecord(
                'やり方書き直しの日誌（書き直していない）',
                `slug=${slug}`,
                kindOfError(error),
              );
              return c.json(journalWriteFailedBody(), 500);
            }
          }
          let practice: Practice;
          try {
            practice = await stores.practices.write({ slug, kind, title, content }, { ifMatch });
          } catch (error) {
            if (rewriting) {
              await humanRetractor(stores, {
                operation: 'やり方を書き直す',
                subject: `やり方 ${slug} の書き直し`,
                what: 'やり方書き直しの打ち消しの日誌',
                detail: `slug=${slug}`,
              })(
                error instanceof PracticeConflictError
                  ? '書き直す直前にやり方が変わっていた（見た版と違う）'
                  : 'やり方の書き込みが失敗した',
              );
            }
            // 黙って上書きしない: 書いていない。
            if (error instanceof PracticeConflictError) {
              return c.json(practiceConflictBody(error.current, 'write'), 409);
            }
            throw error;
          }
          // 書き換え自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
          await appendJournalOrDrop(stores, entryAfter, 'やり方書き換えの日誌', `slug=${slug}`);
          // 読めない形の行の書き直しは置換（`rewriting`）: 新規ではない。
          return c.json({ practice, version: practiceVersion(practice), created: !rewriting });
        },
      )

      .delete(
        '/practices/:slug',
        describeRoute({
          tags: ['practices'],
          summary: 'やり方を1つ消す',
          description:
            '**読んだ版を前提にできる（Issue #2959）。** クエリ `ifMatch` に、読んだ時の版' +
            '（`GET /practices/{slug}` の `version`）を付けると、いまの版と違うとき**何も消さず 409** で' +
            'いまの版を返す（読んだ後にクローンが書いた内容を黙って消さない）。\n\n' +
            '**版は必須。** `ifMatch` を付けない削除は **428** で断り、何も消さず・日誌にも積まず、' +
            'いまの版を `current` に返す（読み直して、その `version` を付けて打ち直す）。' +
            'スラッグが不正なら 400、やり方が無ければ 404 を先に返す。' +
            '**読めない形で入っている行には版が無い**ので、版なしで消せる（回復手段を塞がない）。',
          responses: {
            200: jsonResponse('消した。', practiceDeleteResponseSchema),
            409: jsonResponse(
              '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから消すまでの間に別の書き手が' +
                '書いた）。**何も消していない。** `current` にいまの版を返す。',
              practiceConflictResponseSchema,
            ),
            428: jsonResponse(
              '`ifMatch`（読んだ時の版）が無い。**何も消していない。** `current` にいまの版を返す' +
                '（409 と同じ形）。読めない形で入っている行は、版なしで消せるのでこれを返さない。',
              practiceConflictResponseSchema,
            ),
            400: errorResponse('やり方のスラッグが名前として成立しない（「無い」とは区別する）。'),
            404: errorResponse('該当するやり方が無い。'),
            500: journalWriteFailedResponse('消す前の日誌が書けなかった（**消していない**）。'),
          },
        }),
        queryParams(ifMatchDeleteQuery),
        async (c) => {
          const slug = c.req.param('slug');
          if (!practiceSlugSchema.safeParse(slug).success) {
            return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
          }
          const { ifMatch } = c.req.valid('query');
          // `UnreadablePracticeError` を捕まえて先へ進む: 投げっぱなしにすると DELETE がここで落ち、壊れた行を消す唯一の HTTP 経由の手段が塞がる。本当に無い場合だけ 404。
          let existing: Practice | null;
          let wasUnreadable = false;
          try {
            existing = await stores.practices.read(slug);
          } catch (error) {
            if (!(error instanceof UnreadablePracticeError)) throw error;
            existing = null;
            wasUnreadable = true;
          }
          if (existing === null && !wasUnreadable) {
            return c.json({ error: 'not found' as const }, 404);
          }
          // 読めない形の行（`wasUnreadable`）は版なしで消せる: 読めない行には版が無く（`GET` も 409）、ここで断ると壊れた行を外す回復手段が塞がる。
          if (ifMatch === undefined && existing !== null) {
            return c.json(
              {
                error: '消すやり方の版（ifMatch）が無いので、消していません' as const,
                current: practiceCurrent(existing),
              },
              428,
            );
          }
          // 読んだ版が既に食い違っていれば、日誌を書く前に 409 で返す（消さないので書く跡が無い）。
          if (existing !== null && !practiceVersionMatches(existing, ifMatch)) {
            return c.json(practiceConflictBody(existing, 'remove'), 409);
          }
          // 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない。
          const entryBefore: JournalEntryInput = {
            type: 'decision',
            decision:
              existing !== null
                ? `人間がやり方 ${slug}（${existing.kind}）を消す: ${existing.title}`
                : `人間が読めない形で入っていたやり方 ${slug} を消す`,
            grounds: '人間が直接 API から消そうとしている',
          };
          const entryAfter: JournalEntryInput =
            existing !== null
              ? {
                  type: 'decision',
                  decision: `やり方 ${slug}（${existing.kind}）を消した: ${existing.title}`,
                  grounds: '人間が直接 API からやり方を消した',
                  target: { kind: 'practice', slug },
                  ...humanActionOf(c.get('principal'), 'practice_remove', slug),
                }
              : {
                  type: 'decision',
                  decision: `読めない形で入っていたやり方 ${slug} を消した`,
                  grounds: '人間が直接 API から、読めない形で入っていたやり方を消した',
                  target: { kind: 'practice', slug },
                  ...humanActionOf(c.get('principal'), 'practice_remove', slug),
                };
          // 日誌を先に書き、書けなければ消さずに 500（#5243）: 消すと題と本文が行から消えるので、後に書いて握ると何を消したかが残らない。先の行に humanAction を付けない（印は効いた後の行だけが持つ）。
          try {
            await stores.journal.append(entryBefore);
          } catch (error) {
            noteDroppedRecord(
              'やり方削除の日誌（消していない）',
              `slug=${slug}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          try {
            await stores.practices.remove(slug, ifMatch === undefined ? undefined : { ifMatch });
          } catch (error) {
            await humanRetractor(stores, {
              operation: 'やり方を消す',
              subject: `やり方 ${slug} の削除`,
              what: 'やり方削除の打ち消しの日誌',
              detail: `slug=${slug}`,
            })(
              error instanceof PracticeConflictError
                ? '消す直前にやり方が変わっていた（見た版と違う）'
                : 'やり方の削除が失敗した',
            );
            // 黙って消さない。
            if (error instanceof PracticeConflictError) {
              return c.json(practiceConflictBody(error.current, 'remove'), 409);
            }
            throw error;
          }
          // 削除自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
          await appendJournalOrDrop(stores, entryAfter, 'やり方削除の日誌', `slug=${slug}`);
          return c.json({ ok: true as const, slug });
        },
      )

      // メタだけで本文は含まない: 一覧に本文を全文で載せない（地雷表の禁止）。
      .get(
        '/practices/:slug/versions',
        describeRoute({
          tags: ['practices'],
          summary: 'やり方の版の履歴（メタだけ）',
          description:
            '追記専用の版の履歴——write のたびに増え、remove しても消えない（#1309）。' +
            '版番号の昇順。本文は含まない（個別に読むには GET /practices/:slug/versions/:version）。',
          responses: {
            200: jsonResponse(
              '版のメタ情報一覧（版番号の昇順）。無い slug には空配列を返す。',
              practiceVersionListResponseSchema,
            ),
            400: errorResponse('やり方のスラッグが不正。'),
          },
        }),
        async (c) => {
          // `/practices/:slug` と同じ門: ここが無いと fs/in-memory では空配列が 200 で返り、pg 実装では例外が `onError` で 500 になる非対称が出る。
          const slug = c.req.param('slug');
          if (!practiceSlugSchema.safeParse(slug).success) {
            return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
          }
          return c.json({ versions: await stores.practices.listVersions(slug) });
        },
      )

      .get(
        '/practices/:slug/versions/:version',
        describeRoute({
          tags: ['practices'],
          summary: 'やり方の版を1つ読む（本文まで）',
          responses: {
            200: jsonResponse('版（本文まで）。', practiceVersionReadResponseSchema),
            400: errorResponse('やり方のスラッグが不正、または版番号が正の整数として成立しない。'),
            404: errorResponse('該当する版が無い。'),
            409: errorResponse(
              '該当する版は在るが、型に合わない形で入っていて読めない（消されたのとは区別する。' +
                'issue #2177）。この版を書き直す口は無い——本文はここでは取れない。',
            ),
          },
        }),
        async (c) => {
          // 版番号の検査より前に同じ門を先に通す（`GET /practices/:slug/versions` と順序を揃える）。
          const slug = c.req.param('slug');
          if (!practiceSlugSchema.safeParse(slug).success) {
            return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
          }
          const raw = c.req.param('version');
          const version = Number(raw);
          if (!Number.isInteger(version) || version <= 0) {
            return c.json({ error: '版番号が不正' as const }, 400);
          }
          // `GET /practices/:slug` と同じ判断: 読めない行は素の 500 にせず 409 にする。
          let found: Awaited<ReturnType<typeof stores.practices.readVersion>>;
          try {
            found = await stores.practices.readVersion(slug, version);
          } catch (error) {
            if (!(error instanceof UnreadablePracticeError)) throw error;
            return c.json(
              {
                error:
                  `やり方 ${slug} の版 ${String(version)} は読めない形で入っている` +
                  '（消されたのではない）。本文はここでは取れない。',
              },
              409,
            );
          }
          if (!found) return c.json({ error: 'not found' as const }, 404);
          return c.json({ version: found });
        },
      )
  );
}
