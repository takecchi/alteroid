import type { GrantResult, Stores } from '@alteroid/core';
import {
  UnreadableAccountError,
  isAccountGranted,
  toRowsUnreadable,
  type AuthAccount,
} from '@alteroid/core';
import { bearerOf, type Principal } from './auth.js';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  accessAccountResponseSchema,
  accessListResponseSchema,
  loginClaimResponseSchema,
  loginStartResponseSchema,
  meResponseSchema,
  okResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import {
  deliberateClient,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  LOGGED_IN_WITHOUT_GRANT_DESCRIPTION,
  jsonResponse,
  errorResponse,
  invalidWith,
  jsonBody,
  describeActor,
  appendJournalOrDrop,
  unreadableRowsRemoveHandlers,
} from './app-shared.js';

const loginBody = z.object({
  provider: z.string().min(1),
  label: z.string().max(200).optional(),
});

const claimBody = z.object({ claimSecret: z.string().min(1) });

function loginErrorDetail(reason: string): string {
  switch (reason) {
    case 'invalid_state':
      return 'ログイン要求が見つかりません（やり直してください）。';
    case 'expired':
      return 'ログイン要求の期限が切れています（やり直してください）。';
    case 'already_used':
      return 'このログイン要求は既に使われています。';
    case 'unknown_provider':
      return '設定されていないログイン手段です。';
    default:
      return 'プロバイダとのトークン交換に失敗しました。';
  }
}

function describeAccount(account: AuthAccount): string {
  const name = account.email ?? account.displayName;
  return name === null || name === undefined ? account.id : `${name} (${account.id})`;
}

function claimErrorDetail(reason: string): string {
  switch (reason) {
    case 'invalid_secret':
      return 'claimSecret が違う';
    case 'expired':
      return 'ログイン要求の期限が切れている';
    case 'failed':
      return 'ログインに失敗している';
    default:
      return 'ログイン要求が見つからない（既に引き取り済みの可能性）';
  }
}

// 固定の `'operator'` を書かない: `grantedBy` は「誰が許可したか」を持つ欄で、常に同じ値なら情報を運ばず、事後に追えるという最終承認の実体が記録の側から崩れる。`grantedBy`（正本）は突き合わせ用に id だけ、`grounds` は人間が読む文（`describeActor`）。
function actorOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return principal.account.id;
}

async function accountView(
  stores: Stores,
  account: AuthAccount,
): Promise<
  AuthAccount & {
    granted: boolean;
    identities: {
      provider: string;
      subject: string;
      email: string | null;
      emailVerified: boolean;
      lastLoginAt: string;
    }[];
  }
> {
  const identities = await stores.auth.listIdentities(account.id);
  return {
    ...account,
    granted: isAccountGranted(account),
    identities: identities.map(({ provider, subject, email, emailVerified, lastLoginAt }) => ({
      provider,
      subject,
      email,
      emailVerified,
      lastLoginAt,
    })),
  };
}

// ここで alteroid を操作させない（Web UI は非ゴール）。`autoClose` の成否を判定しない: 同じタブごと遷移していた場合 `window.close()` は黙って何もしないが、メッセージ「閉じて端末に戻る」がフォールバックになる。
function callbackPage(title: string, detail: string, autoClose = false): string {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (ch) =>
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
    );
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>alteroid</title>
<style>
 body{font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;
      display:grid;place-items:center;min-height:100vh;margin:0;color:#1a1a1a;background:#fafafa}
 main{max-width:32rem;padding:2rem;text-align:center}
 h1{font-size:1.25rem;margin:0 0 .75rem}
 p{margin:0;color:#555;line-height:1.7}
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main></body>${
    autoClose ? '<script>window.close()</script>' : ''
  }</html>`;
}

export function authRoutes(ctx: AppContext) {
  const { stores, authPlan, authService, callbackUrl } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 宣言された成功応答（200/202）はすべて宣言スキーマの `.parse()` を通す（エラー応答はその場のリテラルなので通さない）: `resolver()` は spec を作るだけでハンドラの戻り値を検査しないので、通していない経路では宣言に無いフィールドが黙って外へ出る。応答スキーマ（`accountViewSchema` 系）は core の永続化スキーマから独立させてあり、account の行が増えても外へは載らない。
      .post(
        '/auth/login',
        describeRoute({
          tags: ['auth'],
          summary: 'ログインを始める',
          description:
            'ブラウザで開く認可 URL と、結果を引き取るための秘密（`claimSecret`）を返す。' +
            '**この経路は認証を要求しない** — ログインの前に持っている資格が無いのは当たり前で、' +
            'ここを閉じると誰も入れない。得られるのはアカウントの作成までで、' +
            '使う許可は別に人間が与える（`alteroid access grant`）。',
          security: [],
          responses: {
            200: jsonResponse('ログインを開始した。', loginStartResponseSchema),
            400: errorResponse('未知のログイン手段、または手段が1つも設定されていない。'),
          },
        }),
        jsonBody(loginBody, invalidWith('provider/label の形が不正')),
        async (c) => {
          const { provider, label } = c.req.valid('json');
          if (authPlan.providers.length === 0) {
            return c.json({ error: 'ログイン手段が設定されていない' as const }, 400);
          }
          const known = authPlan.providers.some((it) => it.id === provider);
          if (!known) return c.json({ error: `未知のログイン手段: ${provider}` }, 400);

          const started = await authService.startLogin({
            provider,
            label: label ?? '',
            redirectUri: callbackUrl(provider),
          });
          return c.json(loginStartResponseSchema.parse(started));
        },
      )

      .get(
        '/auth/:provider/callback',
        describeRoute({
          tags: ['auth'],
          summary: 'プロバイダからの戻り先',
          description:
            'ブラウザがここへ戻ってくる。応答は人間が読む HTML で、端末（CLI）側が ' +
            '`/auth/login/{requestId}/claim` で結果を引き取る。**トークンはここでは返さない** ' +
            '— ブラウザの履歴や Referer に鍵を載せないため。',
          security: [],
          responses: {
            200: {
              description: 'ログインの成否を人間に伝える画面。',
              content: { 'text/html': { schema: resolver(z.string()) } },
            },
            400: {
              description:
                'プロバイダ側が拒否した（`?error=`）／`code`・`state` が足りない／' +
                '`completeLogin` がエラーを返した、のいずれか。応答は人間が読む HTML。',
              content: { 'text/html': { schema: resolver(z.string()) } },
            },
          },
        }),
        async (c) => {
          const denied = c.req.query('error');
          if (denied !== undefined && denied.length > 0) {
            return c.html(
              callbackPage('ログインを中止しました', `プロバイダからの応答: ${denied}`),
              400,
            );
          }

          const code = c.req.query('code');
          const state = c.req.query('state');
          if (code === undefined || state === undefined) {
            return c.html(
              callbackPage('ログインに失敗しました', 'code と state が足りません。'),
              400,
            );
          }

          const result = await authService.completeLogin({ state, code });
          if (result.status === 'error') {
            return c.html(
              callbackPage('ログインに失敗しました', loginErrorDetail(result.reason)),
              400,
            );
          }
          return c.html(
            callbackPage(
              'ログインしました',
              result.granted
                ? 'この画面は自動で閉じます。閉じない場合は手動で閉じて端末に戻ってください。'
                : 'この画面は自動で閉じます。閉じない場合は手動で閉じて端末に戻ってください。なお、このアカウントにはまだ alteroid を使う許可がありません（alteroid access grant で付与します）。',
              true,
            ),
          );
        },
      )

      .post(
        '/auth/login/:requestId/claim',
        describeRoute({
          tags: ['auth'],
          summary: 'ログイン結果を引き取る',
          description:
            'ブラウザ側が終わっていればアクセストークンを返す。**返るのはこの1回だけ**で、' +
            'ストアには sha256 しか残らない。まだ終わっていなければ 202 と `pending`。',
          security: [],
          responses: {
            200: jsonResponse('トークンを発行した。', loginClaimResponseSchema),
            202: jsonResponse(
              'まだブラウザ側が終わっていない。少し待って再試行する。',
              loginClaimResponseSchema,
            ),
            400: errorResponse('秘密が違う、期限切れ、または既に引き取り済み。'),
          },
        }),
        jsonBody(claimBody, invalidWith('claimSecret の形が不正')),
        async (c) => {
          const result = await authService.claim({
            requestId: c.req.param('requestId'),
            claimSecret: c.req.valid('json').claimSecret,
          });
          if (result.status === 'pending') {
            return c.json(loginClaimResponseSchema.parse({ status: 'pending' as const }), 202);
          }
          if (result.status === 'error')
            return c.json({ error: claimErrorDetail(result.reason) }, 400);
          return c.json(
            loginClaimResponseSchema.parse({
              status: 'ready' as const,
              token: result.token,
              account: result.account,
              granted: isAccountGranted(result.account),
            }),
          );
        },
      )

      .get(
        '/auth/me',
        describeRoute({
          tags: ['auth'],
          summary: 'いま自分が誰として認識されているか',
          responses: {
            200: jsonResponse('認証を通った相手。', meResponseSchema),
            401: errorResponse('資格が無い。'),
            403: errorResponse(
              '連携の鍵（`altk_`）では呼べない（連携の鍵は外部イベントの口にしか入れない）。',
            ),
          },
        }),
        (c) => {
          const principal = c.get('principal');
          if (principal.kind === 'operator') {
            return c.json(meResponseSchema.parse({ kind: 'operator' as const }));
          }
          // 連携の鍵は `authenticate` が既定で拒否するのでここへ来ない: 来たら二重の門で断る。
          if (principal.kind === 'integration') {
            return c.json({ error: '連携の鍵では、この操作はできない' as const }, 403);
          }
          return c.json(
            meResponseSchema.parse({
              kind: 'account' as const,
              account: principal.account,
              granted: isAccountGranted(principal.account),
            }),
          );
        },
      )

      // 提示している1本だけを失効させ、同じアカウントの他のトークンは触らない（アカウントごと締め出すのは `POST /access/:accountId/revoke`）。operator の資格では失効させられない: `AccessTokenRecord` を持たず、失効させる対象が無い別の種類の資格なので 4xx で断り `alteroid access revoke` へ誘導する。応答にトークンの値も sha256 も載せない。
      .post(
        '/auth/logout',
        describeRoute({
          tags: ['auth'],
          summary: 'いま提示しているアクセストークンを失効させる',
          description:
            '同じアカウントの他のトークンは巻き込まない。**operator の資格（状態ファイルの ' +
            'token）では呼べない**——失効させる対象（アクセストークン）を持たないため。',
          requestBody: emptyJsonPostRequestBody('ログアウトさせられないため'),
          responses: {
            200: jsonResponse('失効させた（既に失効済みだった場合を含む）。', okResponseSchema),
            400: errorResponse('operator の資格では失効させられない。'),
            401: errorResponse('資格が無い、またはトークンが既に無効。'),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        async (c) => {
          const principal = c.get('principal');
          if (principal.kind === 'operator') {
            return c.json(
              {
                error:
                  '実行環境の持ち主の資格ではログアウトできない（アクセストークンを持たない）。' +
                  '特定のアカウントを締め出すなら alteroid access revoke を使う',
              },
              400,
            );
          }
          // bearer が無いことは無いはずだが、型では narrow できないため防御的に扱う。
          const bearer = bearerOf(c.req.header('authorization'));
          if (bearer === null) {
            return c.json({ error: 'ログインが要る（alteroid login）' as const }, 401);
          }
          const result = await authService.logout(bearer);
          if (result.status === 'not_found') {
            return c.json({ error: 'トークンが無効か期限切れ（alteroid login をやり直す）' }, 401);
          }
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // 持つのは許可されているか否かの2値だけ: 「chat は可・記憶の編集は不可」のような行為別のスコープを足すと、PRD「権限境界」が禁じている「確認が要る行為の一覧」と同じ形になり、クローンの判断を設定で置き換えることになる。
      .get(
        '/access',
        describeRoute({
          tags: ['access'],
          summary: 'ログインしたアカウントと許可の一覧',
          description:
            'alteroid を使う許可があれば読める（実行環境の持ち主と同格。2026-09-06 の' +
            'オーナー決定）。メールと identity が並ぶ一覧である点は変わらない。',
          responses: {
            200: jsonResponse(
              'アカウントの一覧。読めない行（型に合わない形で入っているアカウント）が1件でも在るときだけ ' +
                '`rowsUnreadable`（件数と id・不正な欄名。email などの中身は載せない）が付く。id を ' +
                '`POST /access/unreadable/remove` に渡して消せる。',
              accessListResponseSchema,
            ),
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
          },
        }),
        async (c) => {
          const accounts = await stores.auth.listAccounts();
          // 0件なら鍵ごと無い。email などの中身は載せない（id と不正な欄名だけ）。
          const rowsUnreadable = toRowsUnreadable(await stores.auth.listUnreadableAccounts());
          return c.json(
            accessListResponseSchema.parse({
              accounts: await Promise.all(accounts.map((account) => accountView(stores, account))),
              ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
            }),
          );
        },
      )

      // 許可は伝播する（A が B を、B が C を通せる）: 代わりに下の日誌が「誰が誰を通したか」を毎回残し、それが伝播を事後に追える唯一の場所になる。
      .post(
        '/access/:accountId/grant',
        describeRoute({
          tags: ['access'],
          summary: 'alteroid を使う許可を与える',
          description:
            'ログインしただけでは使えない。ここで初めて使えるようになる。運ぶ情報は無い' +
            '（`{}` を送る）。\n\n' +
            '**許可できるアカウントの数に上限は無い**（2026-09-09 のオーナー決定。それ' +
            '以前は高々1つで、2人目は 409 だった）。同じ人間が複数のログイン手段から' +
            '入れる。**利用者ごとにデータは分けない** — 許可を持つ全員が同じ1組の記憶・' +
            '日誌・会話を見る（マルチユーザー / チーム利用は docs/PRD.md「スコープ外」の' +
            'ままである）。\n\n' +
            '**この口は許可を持つアカウントからも叩ける**（2026-09-06 のオーナー決定で' +
            '実行環境の持ち主と同格）。⟹ 許可は伝播する。誰が誰を通したかは日誌に残る。',
          requestBody: emptyJsonPostRequestBody('持ち主を足されないため'),
          responses: {
            200: jsonResponse(
              '許可した（既に許可済みでも 200。その場合、日誌には「付与していない（既に許可済みだった）」の打ち消しが残り、`grantedBy` は先の許可者のまま）。',
              accessAccountResponseSchema,
            ),
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
            404: errorResponse('該当するアカウントが無い。'),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        async (c) => {
          const accountId = c.req.param('accountId');
          // 対象を先に引く（門前払い。無ければ 404 で日誌は書かない）: 早期の検査でしかなく、実際に許可される保証は `authService.grant` の結果でしか取れない。
          const before = await stores.auth.getAccount(accountId);
          if (before === null) return c.json({ error: 'not found' as const }, 404);
          const retract = (decision: string, grounds: string) =>
            appendJournalOrDrop(
              stores,
              { type: 'decision', decision, grounds },
              'アクセス許可付与の打ち消しの日誌',
              `accountId=${accountId}`,
            );

          // `describeActor` を省いて `operator` 固定にしない: 許可は人間の手を経ずに伝播しうるので、ここが唯一の歯止め。日誌を先に書き、書けなければ状態を変えずに 500: 状態変更の後に書いて `appendJournalOrDrop` で握ると「記録の無い許可」を作ってしまう。
          await stores.journal.append({
            type: 'decision',
            decision: `アクセス許可を付与: ${describeAccount(before)}`,
            grounds: `${describeActor(c.get('principal'))}（alteroid access grant）`,
          });

          let result: GrantResult;
          try {
            result = await authService.grant(accountId, actorOf(c.get('principal')));
          } catch (error) {
            // 日誌には「付与した」が残っているので打ち消す: 記録が多すぎる側の穴は「記録の無い許可」より安全側。
            await retract(
              `アクセス許可を付与できなかった: ${describeAccount(before)}`,
              `${describeActor(c.get('principal'))}（alteroid access grant、状態の変更が失敗）`,
            );
            throw error;
          }
          if (result.status === 'not_found') {
            // 対象を引いてから状態を変えるまでの間に消えた: 同じ理由で打ち消す。
            await retract(
              `アクセス許可を付与できなかった: ${describeAccount(before)}`,
              `${describeActor(c.get('principal'))}（alteroid access grant、対象が消えていた）`,
            );
            return c.json({ error: 'not found' as const }, 404);
          }
          // 先に読んだ許可と結果が同じなら、この呼びでは何も変わっていない: 先に書いた「付与」を打ち消す。`grantedBy` は先の許可者のままなので、打ち消さないと日誌が操作者を誤って指す。
          if (
            before.grantedAt !== null &&
            result.account.grantedAt === before.grantedAt &&
            result.account.grantedBy === before.grantedBy
          ) {
            await retract(
              `アクセス許可を付与していない（既に許可済みだった）: ${describeAccount(before)}`,
              `${describeActor(c.get('principal'))}（alteroid access grant、` +
                `${before.grantedBy ?? '不明'} が ${before.grantedAt} に許可済み）`,
            );
          }
          return c.json(
            accessAccountResponseSchema.parse({
              account: await accountView(stores, result.account),
            }),
          );
        },
      )

      .post(
        '/access/:accountId/revoke',
        describeRoute({
          tags: ['access'],
          summary: 'alteroid を使う許可を取り消す',
          description:
            '発行済みトークンは消さない。**許可はリクエストごとに見ているので、' +
            'これだけで即座に通らなくなる**（消し忘れたトークンが生き残らない）。運ぶ情報は' +
            '無い（`{}` を送る）。',
          requestBody: emptyJsonPostRequestBody('持ち主の許可を落とされないため'),
          responses: {
            200: jsonResponse(
              '取り消した（既に未許可でも 200。その場合、日誌には「アクセス許可の取り消し（読んだ時点で既に未許可だった）」と残る）。',
              accessAccountResponseSchema,
            ),
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
            404: errorResponse('該当するアカウントが無い。'),
            409: errorResponse(
              '該当するアカウントの行は在るが、型に合わない形で入っていて読めない（居ないのとは' +
                '区別する。issue #2425）。取り消しはこの口ではできず、行は変わっていない。' +
                '読めないアカウントは認可を通らない。消すには ' +
                '`POST /access/unreadable/remove`（issue #2440）。',
            ),
            ...noBodyPostResponses(),
          },
        }),
        deliberateClient,
        async (c) => {
          // 読めない行は「無い」（404）ではなく「読めない形で在る」（409）と言い分ける。
          let account: Awaited<ReturnType<typeof authService.revoke>>;
          // 日誌の書き分けのためだけに取り消す前の状態を読む: 取り消し自体はこの読みに依らず、`authService.revoke` の型は変えない（`/permission-grants/:id/revoke` の `revokedBefore` と同じ形）。読んでから書くまでに別の人が許可すると、実際には取り消したのに「読んだ時点で未許可」と出るので、「取り消していない」とは言い切らない文言にする。状態はこの読みで狂わない。読めない行は `null` になるが、下の `revoke` が 409 で止める。
          const revokedBefore =
            (await stores.auth.getAccount(c.req.param('accountId')))?.grantedAt === null;
          try {
            account = await authService.revoke(c.req.param('accountId'));
          } catch (error) {
            if (!(error instanceof UnreadableAccountError)) throw error;
            return c.json(
              {
                error:
                  `アカウント ${error.id} は読めない形で入っている（消されたのでも、許可が落ちたのでもない）。` +
                  '取り消しはこの口ではできない。本文はここでは取れない。' +
                  '消すには `POST /access/unreadable/remove`（alteroid access remove-unreadable <id>）を使う。',
              },
              409,
            );
          }
          if (account === null) return c.json({ error: 'not found' as const }, 404);
          // 取り消しは効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`。狭める側の扱い）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: revokedBefore
                ? `アクセス許可の取り消し（読んだ時点で既に未許可だった）: ${describeAccount(account)}`
                : `アクセス許可を取り消し: ${describeAccount(account)}`,
              grounds: `${describeActor(c.get('principal'))}（alteroid access revoke${revokedBefore ? '、取り消す前から未許可' : ''}）`,
            },
            'アクセス許可取り消しの日誌',
            `accountId=${account.id}`,
          );
          return c.json(
            accessAccountResponseSchema.parse({ account: await accountView(stores, account) }),
          );
        },
      )

      // `:accountId` と取り違えないよう別の語（`unreadable`）の下に置く。
      .post(
        '/access/unreadable/remove',
        ...unreadableRowsRemoveHandlers({
          stores,
          path: '/access/unreadable/remove',
          tag: 'access',
          summary: '読めないアカウントの行を、id を指して消す',
          description:
            '読めない（型に合わない形で入っている）アカウントの行だけを、id を指して消す。読める' +
            'アカウントには触れない。id が取れない行はこの口では消せない（`auth.json` を手で直す）。' +
            '1つでも読めない行に無い id があれば何も消さない。消した id と件数を日誌に残す' +
            '（行の中身は残さない）。pg はアカウントを列で持つので読めない行が無く、常に 404。',
          extraResponses: { 403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION) },
          subject: 'アカウント',
          noun: 'アカウント',
          hint: '`GET /access` の `rowsUnreadable.rows[].id`（alteroid access list）',
          remove: (ids, options) => authService.removeUnreadableAccounts(ids, options),
        }),
      )
  );
}
