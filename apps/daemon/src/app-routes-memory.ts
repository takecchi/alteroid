import type { JournalEntryInput } from '@alteroid/core';
import {
  type MemoryDocument,
  MemoryConflictError,
  memoryVersion,
  memoryVersionMatches,
  memorySlugSchema,
  noteDroppedRecord,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  memoryDeleteResponseSchema,
  memoryListResponseSchema,
  memoryConflictResponseSchema,
  memoryReadResponseSchema,
  memoryWriteResponseSchema,
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
} from './app-shared.js';

const memoryBody = z.object({ content: z.string(), ifMatch: ifMatchField });

// 記憶・やり方の 409 の本文の組み立て（検査の順序は route ごとに違うので寄せない）。`error` は `as const` のリテラルのまま返す: 文が `string` に広がると `hc` の応答の型が変わる。
const MEMORY_CONFLICT_ERROR = {
  write: '記憶が読んだ後に変わっています（書き換えていません）',
  remove: '記憶が読んだ後に変わっています（消していません）',
} as const;
const memoryCurrent = (document: MemoryDocument) => ({
  document,
  version: memoryVersion(document.content),
});
const memoryConflictBody = <Op extends keyof typeof MEMORY_CONFLICT_ERROR>(
  current: MemoryDocument | null,
  op: Op,
) => ({
  error: MEMORY_CONFLICT_ERROR[op],
  current: current === null ? null : memoryCurrent(current),
});

export function memoryRoutes(ctx: AppContext) {
  const { stores } = ctx;
  return new Hono<{ Variables: AuthVariables }>()
    .get(
      '/memory',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書の一覧',
        description: '記憶（PersonaStore）の文書一覧。本文は含まない（メタ情報だけ）。',
        responses: {
          200: jsonResponse('記憶文書のメタ情報一覧。', memoryListResponseSchema),
        },
      }),
      async (c) => c.json({ documents: await stores.persona.list() }),
    )

    .get(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を1つ読む',
        responses: {
          200: jsonResponse('記憶文書。', memoryReadResponseSchema),
          400: errorResponse('記憶のスラッグが不正。'),
          404: errorResponse('該当する記憶が無い。'),
        },
      }),
      async (c) => {
        // `PUT`/`DELETE` と同じ門: ここが無いと `FsPersonaStore#path` が投げる例外が `onError` まで抜けて 500 になり、同じ入力なのに応答が違う。
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const doc = await stores.persona.read(slug);
        if (!doc) return c.json({ error: 'not found' as const }, 404);
        return c.json({ document: doc, version: memoryVersion(doc.content) });
      },
    )

    .put(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を全文置換で書く',
        description:
          '人間が API から記憶を書き換える口。書き換えは日誌に残る（`cause: human`）。' +
          '日誌を先に書き、書けなければ本文を書かずに 500 を返す（印の付かない保存を起こさない）。' +
          '本文が書けなかった（409 ほか）ときは、日誌に打ち消しの行（`action: write_failed`）を足す。',
        responses: {
          200: jsonResponse(
            '書き換え後の記憶文書。`created` は新規なら true、置換なら false。',
            memoryWriteResponseSchema,
          ),
          400: errorResponse('記憶のスラッグが不正、または本文が JSON として不正。'),
          409: jsonResponse(
            '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから書くまでの間に別の書き手が' +
              '書いた、または消した）。**何も書いていない。** `current` にいまの版を返す。',
            memoryConflictResponseSchema,
          ),
          500: journalWriteFailedResponse('日誌が書けなかった（**本文を書いていない**）。'),
        },
      }),
      jsonBody(memoryBody, invalidWith('記憶の本文の形が不正')),
      async (c) => {
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const before = await stores.persona.read(slug);
        const { content, ifMatch } = c.req.valid('json');
        // 読んだ版が既に食い違っていれば、日誌を書く前に 409 で返す: ふつうの衝突のたびに `write` と `write_failed` の2行を日誌へ積まないため。
        // ここを抜けた後に割り込まれた回は、下の `persona.write` の排他が 409 にし、打ち消しの行で対応を保つ。
        if (!memoryVersionMatches(before, ifMatch)) {
          return c.json(memoryConflictBody(before, 'write'), 409);
        }
        // 日誌を先に書き、書けなければ本文を書かずに 500（#4774）: 本文の後に書いて `appendJournalOrDrop` で握ると、本文は変わったのに裏付けの `cause:'human'` の行が無く、`markHumanTouched` も呼べない「印の付かない人間の保存」が生まれる（クローンが次の蒸留で黙って上書きできてしまう）。
        let entry;
        try {
          entry = await stores.journal.append({
            type: 'memory_update',
            slug,
            cause: 'human',
            action: 'write',
            // クローンの道具（memory_write）と同じ機械可読な面: 片方だけ足すと「人間の書き込みだけ数えられない」が生まれる。
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(content, 'utf8'),
            summary: 'HTTP API 経由で人間が記憶を書き換えた',
          });
        } catch (error) {
          noteDroppedRecord(
            '記憶書き換えの日誌（保存していない）',
            `slug=${slug}`,
            kindOfError(error),
          );
          return c.json(journalWriteFailedBody(), 500);
        }
        let doc;
        try {
          // 印（`humanTouchedAt`）は本文と同じ排他・同じ1文で立てる: 本文の後に別の呼び出しで立てると、その間は `clone-only` で、蒸留が人間の本文を全置換・削除できた。書けなかった回は印も立たない。裏付けの行は上で先に書いてある。
          doc = await stores.persona.write(slug, content, { ifMatch, humanTouchedAt: entry.at });
        } catch (error) {
          // 日誌には「人間が書いた」が残っているので打ち消す: `deriveHumanTouchedAtFromJournal` が、この行を印の根拠にしない。足せなければ跡だけ残し（`appendJournalOrDrop`）、応答は元の失敗のまま返す（再構築で印が立ちうるのは守りすぎの側）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'memory_update',
              slug,
              cause: 'human',
              action: 'write_failed',
              summary:
                'HTTP API 経由の人間の保存は本文に届かなかった（直前の write の行を打ち消す）',
            },
            '記憶書き換えの打ち消しの日誌',
            `slug=${slug}`,
          );
          // 黙って上書きしない: 書いていない。
          if (error instanceof MemoryConflictError) {
            return c.json(memoryConflictBody(error.current, 'write'), 409);
          }
          throw error;
        }
        // 無い slug への書き込みは新規作成: 打ち間違いの slug が更新と同じ 200 に紛れないよう、応答で言い分ける。
        return c.json({
          document: doc,
          version: memoryVersion(doc.content),
          created: before === null,
        });
      },
    )

    .delete(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を消す',
        description:
          '書けるのに消せないと、間違って作った記憶が永久に判断の材料に残る。消した事実は' +
          '日誌に残る（`cause: human`）ので、記憶から消えても記録からは消えない。\n\n' +
          '**読んだ版を前提にできる（Issue #2881）。** クエリ `ifMatch` に、読んだ時の版' +
          '（`GET /memory/{slug}` の `version`）を付けると、いまの版と違うとき**何も消さず 409** で' +
          'いまの版を返す（読んだ後にクローンが書いた内容を黙って消さない）。\n\n' +
          '**版は必須。** `ifMatch` を付けない削除は **428** で断り、何も消さず・日誌にも積まず、' +
          'いまの版を `current` に返す（読み直して、その `version` を付けて打ち直す）。' +
          'スラッグが不正なら 400、記憶が無ければ 404 を先に返す。',
        responses: {
          200: jsonResponse('消した。', memoryDeleteResponseSchema),
          409: jsonResponse(
            '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから消すまでの間に別の書き手が' +
              '書いた）。**何も消していない。** `current` にいまの版を返す。',
            memoryConflictResponseSchema,
          ),
          428: jsonResponse(
            '`ifMatch`（読んだ時の版）が無い。**何も消していない。** `current` にいまの版を返す' +
              '（409 と同じ形）。',
            memoryConflictResponseSchema,
          ),
          400: errorResponse('記憶のスラッグが名前として成立しない（「無い」とは区別する）。'),
          404: errorResponse('該当する記憶が無い。'),
          500: journalWriteFailedResponse('消す前の日誌が書けなかった（**消していない**）。'),
        },
      }),
      queryParams(ifMatchDeleteQuery),
      async (c) => {
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const { ifMatch } = c.req.valid('query');
        const existing = await stores.persona.read(slug);
        if (existing === null) return c.json({ error: 'not found' as const }, 404);
        // 読み直せるよう、いまの版を 409 と同じ形で返す。
        if (ifMatch === undefined) {
          return c.json(
            {
              error: '消す記憶の版（ifMatch）が無いので、消していません' as const,
              current: memoryCurrent(existing),
            },
            428,
          );
        }
        // 読んだ版が既に食い違っていれば、日誌を書く前に 409 で返す（消さないので書く跡が無い。ふつうの衝突のたびに2行を積まない）。
        if (!memoryVersionMatches(existing, ifMatch)) {
          return c.json(memoryConflictBody(existing, 'remove'), 409);
        }
        // 日誌を先に書き、書けなければ消さずに 500（#5243）: 消した後に書いて `appendJournalOrDrop` で握ると、人間がクローンの記憶を消したのにクローンへ名指しされず、学びにもならない。
        // 先の行は `memory_update`（`cause:'human'`）にせず `decision` にする: `memory_update` の `cause:'human'` は `deriveHumanTouchedAtFromJournal` などが派生値の根拠に読む行なので、消せなかった回に残すと派生を誤らせる。`decision` の先の行は humanAction を持たないので、クローンへ名指しもされない。
        // 効いた後の `memory_update` の行（下）は今までどおり。
        const entryBefore: JournalEntryInput = {
          type: 'decision',
          decision: `人間が記憶 ${slug} を消す`,
          grounds: '人間が直接 API から消そうとしている',
        };
        try {
          await stores.journal.append(entryBefore);
        } catch (error) {
          noteDroppedRecord('記憶削除の日誌（消していない）', `slug=${slug}`, kindOfError(error));
          return c.json(journalWriteFailedBody(), 500);
        }
        // `markHumanTouched` はここでは呼ばない: `PersonaStore.remove` が保護状態の派生値も一緒に消す（実体の無い印は監査上の嘘になる）ので、印を立てても同じ操作の中で消える。delete は「人間の意思で消した」であって、将来ここに書かれる新しい内容を無条件に保護する理由にならない。
        try {
          await stores.persona.remove(slug, { ifMatch });
        } catch (error) {
          // 先の行を打ち消す: 消していない。
          await humanRetractor(stores, {
            operation: '記憶を消す',
            subject: `記憶 ${slug} の削除`,
            what: '記憶削除の打ち消しの日誌',
            detail: `slug=${slug}`,
          })(
            error instanceof MemoryConflictError
              ? '消す直前に記憶が書き換えられていた（見た版と違う）'
              : '記憶の削除が失敗した',
          );
          if (error instanceof MemoryConflictError) {
            return c.json(memoryConflictBody(error.current, 'remove'), 409);
          }
          throw error;
        }
        // 削除自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
        await appendJournalOrDrop(
          stores,
          {
            type: 'memory_update',
            slug,
            cause: 'human',
            action: 'remove',
            bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
            bytesAfter: 0,
            summary: 'HTTP API 経由で人間が記憶を削除した',
          },
          '記憶削除の日誌',
          `slug=${slug}`,
        );
        return c.json({ ok: true as const, slug });
      },
    );
}
