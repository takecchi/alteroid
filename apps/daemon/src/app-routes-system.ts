import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import { isOperator, type AuthVariables } from './auth.js';
import { healthResponseSchema, statusResponseSchema } from './openapi.js';
import { jsonResponse, errorResponse } from './app-shared.js';

export function systemRoutes(ctx: AppContext, deps: AppDeps) {
  const { clone, authPlan, providerList } = ctx;

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get(
        '/health',
        describeRoute({
          tags: ['system'],
          summary: '死活監視と本人確認',
          description:
            'デーモンが応答しているかと、その pid・認証の状態を返す。' +
            '**記憶の置き場は返さない**（無認証で読める応答に、内部のホスト名・DB 名・ホームのパスを' +
            '置かない。#2869）。認証の要る `GET /status` が返す。' +
            '`Authorization: Bearer <state/daemon.json の token>` を添えると `operator` が ' +
            'true になり、CLI はこれで「自分が起こしたデーモンか」を確かめる（PID は信用しない）。' +
            '**トークンそのものは返さない** — この値は許可を付与できる資格そのものなので、' +
            '無認証で読める応答には置けない。',
          security: [],
          responses: {
            200: jsonResponse('応答している。', healthResponseSchema),
          },
        }),
        (c) =>
          c.json({
            ok: true,
            pid: process.pid,
            operator: isOperator(c, deps.token),
            auth: { enabled: authPlan.enabled, providers: providerList },
          }),
      )

      // `isPublicPath` に入れない: 内部のホスト名・DB 名・ホームのパスは、ログインしていない相手に読ませない。
      .get(
        '/status',
        describeRoute({
          tags: ['system'],
          summary: 'デーモン自身の説明（記憶の置き場。資格が要る）',
          description:
            '記憶の置き場（PostgreSQL なら `host:port/db`、ファイルなら記憶ディレクトリのパス）を返す。' +
            '接続情報（パスワード等）は含めない。無認証の `GET /health` は置き場を返さないので、' +
            '置き場を知りたい呼び出し元はログインの後ろのここから取る。',
          responses: {
            200: jsonResponse('認証を通った相手への説明。', statusResponseSchema),
            401: errorResponse('資格が無い。'),
          },
        }),
        (c) => {
          const refusal = clone.sessionRefusal();
          return c.json(
            statusResponseSchema.parse({
              storage: deps.storage ?? '',
              ...(refusal === null ? {} : { cloneSessionRefusal: refusal }),
            }),
          );
        },
      )
  );
}
