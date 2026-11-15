import {
  ISSUED_ACCESS_TOKEN_DEFAULT_TTL_DAYS,
  accessTokenFingerprint,
  isAccountGranted,
  noteDroppedRecord,
  type AccessTokenRecord,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  accessTokenAccountQuerySchema,
  accessTokenCreateRequestSchema,
  accessTokenCreateResponseSchema,
  accessTokenResponseSchema,
  accessTokensListResponseSchema,
} from './openapi.js';
import type { AppContext } from './app-context.js';
import type { AuthVariables, Principal } from './auth.js';
import {
  appendJournalOrDrop,
  deliberateClient,
  describeActor,
  emptyJsonPostRequestBody,
  errorResponse,
  invalidWith,
  journalWriteFailedBody,
  journalWriteFailedResponse,
  jsonBody,
  jsonResponse,
  kindOfError,
  noBodyPostResponses,
  queryParams,
} from './app-shared.js';

const MS_PER_DAY = 86_400_000;

// 値も sha256 の全体も載せない（指紋＝先頭12桁だけ）。
function accessTokenView(token: AccessTokenRecord) {
  return {
    id: token.id,
    accountId: token.accountId,
    name: token.label,
    kind: token.kind,
    origin: token.origin,
    issuedBy: token.issuedBy,
    fingerprint: accessTokenFingerprint(token.sha256),
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  };
}

// 名前・種類・id・指紋・アカウント・期限だけ（値は書かない）。
function describeAccessToken(token: AccessTokenRecord): string {
  return (
    `「${token.label}」（id=${token.id}、種類=${token.kind}、指紋=${accessTokenFingerprint(token.sha256)}、` +
    `アカウント=${token.accountId}、期限=${token.expiresAt ?? 'なし'}）`
  );
}

// 固定値を書かない: 発行した主体（`issuedBy`）は「誰が発行したか」を運ぶ欄で、常に同じ値なら情報を運ばない（`grantedBy` と同じ。`operator` は持ち主の資格のときだけ）。
function issuerOf(principal: Principal): string {
  return principal.kind === 'account' ? principal.account.id : 'operator';
}

type TargetAccount = { accountId: string } | { refusal: 400 | 403; error: string };

export function accessTokensRoutes(
  ctx: AppContext,
  loginCredentialOnly: MiddlewareHandler<{ Variables: AuthVariables }>,
) {
  const { stores, authService, clock } = ctx;

  // アカウントの資格は自分のアカウントだけ（他のアカウントは 403）。operator は `accountId` が必須。
  function resolveTarget(principal: Principal, requested: string | undefined): TargetAccount {
    if (principal.kind === 'account') {
      if (requested !== undefined && requested !== principal.account.id) {
        return {
          refusal: 403,
          error: '自分のアカウントのアクセストークンだけ扱える（他のアカウントは指定できない）',
        };
      }
      return { accountId: principal.account.id };
    }
    if (requested === undefined) {
      return { refusal: 400, error: '実行環境の持ち主の資格では accountId が要る' };
    }
    return { accountId: requested };
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      // 値も sha256 の全体も返さない（見分けるための先頭12桁だけ）。
      .get(
        '/access-tokens',
        describeRoute({
          tags: ['access-tokens'],
          summary: 'アクセストークンの一覧',
          description:
            'そのアカウントのアクセストークンの一覧（失効・期限切れ・ログインで発行したものを含む）。' +
            '**値も sha256 の全体も返さない**（`fingerprint` は sha256 の先頭12桁）。' +
            '人間（実行環境の持ち主と、ログインで発行したトークンのアカウント）だけが呼べる。' +
            '**発行したトークン（`read` / `full`）と連携の鍵は 403。** アカウントの資格は自分のアカウントだけ、' +
            'operator は `accountId` クエリが必須。',
          responses: {
            200: jsonResponse('アクセストークンの一覧。', accessTokensListResponseSchema),
            400: errorResponse('operator の資格で `accountId` が無い。'),
            403: errorResponse(
              '発行したトークン・連携の鍵からは呼べない。または他のアカウントを指定した。',
            ),
            404: errorResponse('operator の資格で指定したアカウントが無い。'),
          },
        }),
        loginCredentialOnly,
        queryParams(accessTokenAccountQuerySchema),
        async (c) => {
          const target = resolveTarget(c.get('principal'), c.req.valid('query').accountId);
          if ('refusal' in target) return c.json({ error: target.error }, target.refusal);
          if (c.get('principal').kind === 'operator') {
            if ((await stores.auth.getAccount(target.accountId)) === null) {
              return c.json({ error: 'not found' as const }, 404);
            }
          }
          const tokens = await authService.listAccessTokens(target.accountId);
          return c.json(
            accessTokensListResponseSchema.parse({ tokens: tokens.map(accessTokenView) }),
          );
        },
      )

      // 日誌を先に書き、書けなければ状態を変えずに 500: 能力を広げる口は記録の無い変更を作らない。日誌にトークンの値は書かない。
      .post(
        '/access-tokens',
        describeRoute({
          tags: ['access-tokens'],
          summary: 'アクセストークンを発行する',
          description:
            '別の環境のクローンなどへ渡すアクセストークンを発行する（HTTP API でも `POST /mcp` でも使える）。' +
            '**種類は決まった2つだけ**: `read`（既定。記憶・日誌・利用などの読み取りと MCP の読み取りの道具だけ通る。' +
            '書き込み・鍵や資格の読み出し・トークンの管理は 403）と `full`（ログインのトークンと同じ強さ）。' +
            '選べる許可の一覧（`scopes`）は無い。**どちらの種類でも、発行したトークンからは' +
            'アクセストークンの発行・一覧・失効を呼べない**（403。自分自身の失効は `POST /auth/logout`）。\n\n' +
            '**期限の既定は 30 日**。無期限は `expiresAt: null` を明示したときだけ。過去の期限は 400。' +
            '**値（`alt_...`）はこの応答で1度だけ返し、後からは取り出せない**（保存は sha256 だけ）。' +
            'アカウントの資格は自分のアカウントにだけ発行できる。operator の資格では `accountId` が必須で、' +
            '許可済みのアカウントでなければ 400。\n\n' +
            '2026-11-15 のオーナー決定。逐語は「トークン発行→APIでも使用できるしMCPでも使用できる」' +
            '「選択式にすればいいと思うけど権限」。',
          responses: {
            200: jsonResponse(
              '発行した。`value` はこの応答でだけ見える。',
              accessTokenCreateResponseSchema,
            ),
            400: errorResponse(
              '入力の形が不正（名前が空・長すぎる・NUL や孤立サロゲートを含む、種類が `read` / `full` でない）、' +
                '期限が過去、または operator の資格で `accountId` が無い・許可済みのアカウントでない（何も作っていない）。',
            ),
            403: errorResponse(
              '発行したトークン・連携の鍵からは呼べない。または他のアカウントへ発行しようとした。',
            ),
            500: journalWriteFailedResponse('日誌が書けなかった（**状態を変えていない**）。'),
          },
        }),
        loginCredentialOnly,
        jsonBody(
          accessTokenCreateRequestSchema,
          invalidWith('アクセストークンの入力の形が不正（何も作っていない）'),
        ),
        async (c) => {
          const input = c.req.valid('json');
          const principal = c.get('principal');
          const target = resolveTarget(principal, input.accountId);
          if ('refusal' in target) return c.json({ error: target.error }, target.refusal);
          if (principal.kind === 'operator') {
            const account = await stores.auth.getAccount(target.accountId);
            if (account === null || !isAccountGranted(account)) {
              return c.json(
                { error: '許可済み（granted）のアカウントにだけ発行できる（何も作っていない）' },
                400,
              );
            }
          }
          const at = clock();
          // 無期限は `null` を明示したときだけ。省略は 30 日後
          const expiresAt =
            input.expiresAt === undefined
              ? new Date(
                  at.getTime() + ISSUED_ACCESS_TOKEN_DEFAULT_TTL_DAYS * MS_PER_DAY,
                ).toISOString()
              : input.expiresAt;
          if (expiresAt !== null && !(Date.parse(expiresAt) > at.getTime())) {
            return c.json({ error: 'expiresAt が過去（何も作っていない）' as const }, 400);
          }

          // 日誌が落ちたかを区別する: 落ちたなら状態は変わっておらず打ち消しは要らない（500）。状態の変更が落ちたなら「発行した」が残っているので打ち消す
          const progress: { journalFailed: boolean; record: AccessTokenRecord | null } = {
            journalFailed: false,
            record: null,
          };
          let issued;
          try {
            issued = await authService.issueAccessToken({
              accountId: target.accountId,
              name: input.name,
              kind: input.kind ?? 'read',
              expiresAt,
              issuedBy: issuerOf(principal),
              beforeSave: async (record) => {
                progress.record = record;
                try {
                  await stores.journal.append({
                    type: 'decision',
                    decision: `アクセストークンを発行: ${describeAccessToken(record)}`,
                    grounds:
                      `${describeActor(principal)}（POST /access-tokens）。` +
                      'トークンの値は書かない（名前・種類・id・指紋・発行した主体だけ）。',
                  });
                } catch (error) {
                  progress.journalFailed = true;
                  noteDroppedRecord(
                    'アクセストークンの発行の日誌（発行していない）',
                    `id=${record.id}`,
                    kindOfError(error),
                  );
                  throw error;
                }
              },
            });
          } catch (error) {
            if (progress.journalFailed) return c.json(journalWriteFailedBody(), 500);
            if (progress.record !== null) {
              // 日誌には「発行した」が残っているので打ち消す（記録が多すぎる側に倒す）。
              await appendJournalOrDrop(
                stores,
                {
                  type: 'decision',
                  decision: `アクセストークンを発行できなかった: ${describeAccessToken(progress.record)}`,
                  grounds: `${describeActor(principal)}（POST /access-tokens、保存が失敗）`,
                },
                'アクセストークンの発行の打ち消しの日誌',
                `id=${progress.record.id}`,
              );
            }
            throw error;
          }
          return c.json(
            accessTokenCreateResponseSchema.parse({
              token: accessTokenView(issued.token),
              value: issued.value,
            }),
          );
        },
      )

      // 冪等: 失効済みはそのまま 200 で、先の時刻を動かさず日誌も足さない。
      .post(
        '/access-tokens/:id/revoke',
        describeRoute({
          tags: ['access-tokens'],
          summary: 'アクセストークンを失効させる',
          description:
            'そのアカウントのアクセストークンを id で失効させる。以後そのトークンは 401 になる。' +
            '失効済みへの再実行は 200（先の失効の時刻を動かさない）。他のアカウントの id は 404。' +
            'operator は `accountId` クエリが必須。**発行したトークン・連携の鍵からは呼べない（403）** ' +
            '— 自分自身の失効は `POST /auth/logout`。',
          requestBody: emptyJsonPostRequestBody('失効させられないため'),
          responses: {
            200: jsonResponse('失効した（既に失効済みでも 200）。', accessTokenResponseSchema),
            400: errorResponse('operator の資格で `accountId` が無い。'),
            403: errorResponse(
              '発行したトークン・連携の鍵からは呼べない。または他のアカウントを指定した。',
            ),
            404: errorResponse('該当するトークン（そのアカウントの）が無い。'),
            500: journalWriteFailedResponse('日誌が書けなかった（**状態を変えていない**）。'),
            ...noBodyPostResponses(),
          },
        }),
        loginCredentialOnly,
        deliberateClient,
        queryParams(accessTokenAccountQuerySchema),
        async (c) => {
          const principal = c.get('principal');
          const id = c.req.param('id');
          const target = resolveTarget(principal, c.req.valid('query').accountId);
          if ('refusal' in target) return c.json({ error: target.error }, target.refusal);
          const before = (await authService.listAccessTokens(target.accountId)).find(
            (token) => token.id === id,
          );
          if (before === undefined) return c.json({ error: 'not found' as const }, 404);
          if (before.revokedAt !== null) {
            return c.json(accessTokenResponseSchema.parse({ token: accessTokenView(before) }));
          }
          try {
            await stores.journal.append({
              type: 'decision',
              decision: `アクセストークンを失効: ${describeAccessToken(before)}`,
              grounds: `${describeActor(principal)}（POST /access-tokens/:id/revoke）`,
            });
          } catch (error) {
            noteDroppedRecord(
              'アクセストークンの失効の日誌（失効していない）',
              `id=${id}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          const cancel = (why: string) =>
            appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `アクセストークンを失効できなかった: ${describeAccessToken(before)}`,
                grounds: `${describeActor(principal)}（POST /access-tokens/:id/revoke、${why}）`,
              },
              'アクセストークンの失効の打ち消しの日誌',
              `id=${id}`,
            );
          let result;
          try {
            result = await authService.revokeAccessTokenById(target.accountId, id);
          } catch (error) {
            await cancel('状態の変更が失敗');
            throw error;
          }
          if (result.status === 'not_found') {
            await cancel('対象が消えていた');
            return c.json({ error: 'not found' as const }, 404);
          }
          if (result.status === 'already_revoked') {
            // 読んでから書くまでの間に別の失効が先に立った: 先に書いた「失効」は、この呼びが動かしたものではない
            await cancel('読んでから失効するまでの間に別の失効が先に立っていた');
          }
          return c.json(accessTokenResponseSchema.parse({ token: accessTokenView(result.token) }));
        },
      )
  );
}
