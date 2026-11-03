import { rm } from 'node:fs/promises';
import { reasonOf, describeResetTargets, resetWorkspaceState } from '@alteroid/core';
import { AttachmentContentRemoveError, writeStderrLine } from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { okResponseSchema, resetRequestSchema, resetResponseSchema } from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  deliberateClient,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  NO_ACCESS_GRANT_DESCRIPTION,
  jsonResponse,
  errorResponse,
  jsonBody,
  describeActor,
  appendJournalOrDrop,
} from './app-shared.js';

export function adminRoutes(ctx: AppContext, deps: AppDeps) {
  const { stores } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 資格は `authenticate` だけで `requireOperator` は付けない: 基準は「壊すかどうか」ではなく、鍵そのものを扱う口だけが一段上の強さを持つ。ここは鍵を扱わず記憶も台帳も消さず、止めた後に起動し直せば元に戻る（`POST /reset` とは取り返しのつき方が違う）。`deliberateClient` は資格の門ではない（ブラウザの単純リクエストを止めるもの）ので、資格の門が見当たらないのを「付け忘れ」と読まないこと。
      .post(
        '/shutdown',
        describeRoute({
          tags: ['system'],
          summary: 'デーモンを止める',
          description: '`daemon stop` の受け口。運ぶ情報は無い（`{}` を送る）。',
          requestBody: emptyJsonPostRequestBody('デーモンを止められないため'),
          responses: {
            200: jsonResponse('停止を受け付けた（実際の停止は少し遅れる）。', okResponseSchema),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        (c) => {
          setTimeout(() => deps.shutdown(), 10);
          return c.json({ ok: true });
        },
      )

      // `confirm: true` を必須にする: 確認ダイアログは呼ぶ前の話で、この口自体にも確認の印を要求して確認を経ない直接の呼び出し（スクリプト等）を 400 で止める。`access grant` だけのアカウントに記憶そのものを消せる資格までは渡さない。
      .post(
        '/reset',
        describeRoute({
          tags: ['system'],
          summary: 'トークン情報以外のワークスペースを全部消す',
          // `describeResetTargets()` から組み立てる（CLI の確認の文と同じ出所）: 手で書き写すとここだけ古くなる。
          description:
            `${describeResetTargets()}を全部消す。` +
            '**認証トークンのプール・マネージャーへ降ろす環境変数・Web UI の' +
            'ログインアカウントは消さない。** 取り消せない。',
          responses: {
            200: jsonResponse('消した件数の内訳。', resetResponseSchema),
            400: errorResponse('`confirm: true` を伴っていない。'),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            503: errorResponse(
              '添付の中身を置き場から消せなかったので、添付は消していない（添付より前の順に消すものは消えている。#4814）。本文の `error` に理由。もう一度リセットすると再試行する。',
            ),
          },
        }),
        jsonBody(resetRequestSchema, () => ({
          error: '`confirm: true` を伴っていない（取り消せない操作なので確認を必須にしてある）',
        })),
        async (c) => {
          let cleared: Awaited<ReturnType<typeof resetWorkspaceState>>;
          try {
            cleared = await resetWorkspaceState(stores, {
              ...(deps.clearSessionLog === undefined
                ? {}
                : { clearSessionLog: deps.clearSessionLog }),
            });
          } catch (error) {
            if (!(error instanceof AttachmentContentRemoveError)) throw error;
            // 添付は最後のほうに消す: ここへ来た時点で、記憶・日誌などは消えている（途中で止まった）。500 で理由を隠さず、残ったものと再試行できることを言う。
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision:
                  'ワークスペースのリセットが途中で止まった（添付の中身を置き場から消せなかった。添付と、それより後の消去は済んでいない）',
                grounds: `${describeActor(c.get('principal'))}（POST /reset）。理由: ${error.reason}。もう一度リセットすると再試行する。`,
              },
              'ワークスペースリセットの断りの日誌',
              `id=${error.id}`,
            );
            return c.json(
              {
                error: `添付の中身を置き場から消せなかったので、リセットが途中で止まった（添付は消していない。それ以前の消去は済んでいる）。理由: ${error.reason}。もう一度リセットすると再試行する`,
              },
              503,
            );
          }
          // 写しは置き場の外のファイルなのでここで消す。消せなくても 500 にしない: 本体はもう消えており、申告の `cleared` を失わない。
          if (deps.attachmentCopiesDir !== undefined) {
            await rm(deps.attachmentCopiesDir, { recursive: true, force: true }).catch(
              (error: unknown) => {
                writeStderrLine(
                  `alteroidd: リセットで添付の写しを消せなかった: ${reasonOf(error)}\n`,
                );
              },
            );
          }
          // 日誌が落ちても 500 を返さない（特に重要）: `cleared` は取り消せない操作の唯一の申告で、500 にすると実際には消えている件数が応答から失われる。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: 'ワークスペースをリセットした（トークン情報以外を全部消した）',
              grounds: `${describeActor(c.get('principal'))}（POST /reset。confirm 済み）`,
            },
            'ワークスペースリセットの日誌',
            `cleared=${JSON.stringify(cleared)}`,
          );
          return c.json(resetResponseSchema.parse({ cleared }));
        },
      )
  );
}
