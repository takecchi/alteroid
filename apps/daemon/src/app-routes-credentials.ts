import type { ApplyCredentialsResult } from '@alteroid/core';
import {
  CredentialEntryRejectedError,
  reasonOf,
  NulNotAllowedError,
  InvalidCredentialNameError,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import {
  credentialsResponseSchema,
  codexAuthStatusResponseSchema,
  codexLoginResponseSchema,
  codexLogoutResponseSchema,
  credentialsUpdateRequestSchema,
  credentialsUpdateResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  NO_ACCESS_GRANT_DESCRIPTION,
  jsonResponse,
  errorResponse,
  invalidWith,
  jsonBody,
  describeActor,
  appendJournalOrDrop,
  kindOfError,
  describePluginDelivery,
} from './app-shared.js';

const CANONICAL_STORE_MISSING_DESCRIPTION = '正本の器が無い。';

export function credentialsRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 資格は `authenticate` だけで `requireOperator` は付けない: 返すのは指紋で、同じ指紋は `GET /runners` が同じ資格で出している。揃えないと、「届いているか」を確かめたいだけの人が持ち主の資格を要求される。値を返す口は作らない。
      .get(
        '/credentials',
        describeRoute({
          tags: ['credentials'],
          summary: 'マネージャーへ降ろす環境変数の指紋を読む',
          description:
            '正本に在る名前と指紋を返す。**値は返さない。** 届いているかは ' +
            'GET /runners の credentials（runner 側の指紋）と突き合わせる。',
          responses: {
            200: jsonResponse('正本に在る鍵の指紋。', credentialsResponseSchema),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        async (c) => {
          if (deps.credentials === undefined) {
            return c.json({ error: '鍵の正本の器が無い' as const }, 503);
          }
          return c.json(
            credentialsResponseSchema.parse({ credentials: await deps.credentials.fingerprints() }),
          );
        },
      )

      // 鍵の口はここだけ（正本へ置くので、器が入れ替わっても `hello` のときに降り直す。保管せず降ろすだけの口は無い）。「置けるが読み出せない」は意図した非対称: ここの資格が漏れて起きるのは「今後の鍵が書き換わる」で、「いま在る鍵が流出する」ではない（`/profile` は応答本文に鍵が丸ごと載るので緩めていない）。
      // 能力を広げる口なので日誌を先に書き、書けなければ差し替えずに 500: 差し替えの後に書くと、追記だけが落ちて 500 を返す一方で差し替えは効いたまま残る。差し替えが投げたら打ち消しの行を足す。検証と保存が同じ1呼び（`apply`）の中にあるので、検証で断られた回も同じ扱い（記録が多すぎる側に倒す）。
      .put(
        '/credentials',
        describeRoute({
          tags: ['credentials'],
          summary: 'マネージャーへ降ろす環境変数を置いて配る',
          description:
            '**部分更新**（入力に無い名前は触らない）。空文字は「その名前を外す」。' +
            '正本へ置いてから全 runner へ降ろす。器を作り直しても hello のときに降り直す。',
          responses: {
            200: jsonResponse(
              '正本の指紋と、各 runner への配布結果。',
              credentialsUpdateResponseSchema,
            ),
            400: errorResponse(
              '本文の形が不正、または置かせない名前だった（**1文字も置いていない**）。' +
                '**送られてきた本文は返さない**——ここは鍵の値そのものを運ぶ口なので、' +
                '既定の 400 の形は使えない（下の `jsonBody` の hook の doc）。',
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        // 既定の 400 を使わない: `hook` を渡さないと `@hono/standard-validator` が本文そのものを `data` に載せて返し（`RESTRICTED_DATA_FIELDS` は cookie だけで `json` は素通し）、`name` の形式ミス1つでその回に送った全部の鍵の値が応答へ載る。返すのは `path` だけ。
        jsonBody(credentialsUpdateRequestSchema, invalidWith('鍵の入力の形が不正（置いていない）')),
        async (c) => {
          if (deps.credentials === undefined) {
            return c.json({ error: '鍵の正本の器が無い' as const }, 503);
          }
          const entries = c.req.valid('json').credentials;
          const setNames = entries.filter((e) => e.value.length > 0).map((e) => e.name);
          const removedNames = entries.filter((e) => e.value.length === 0).map((e) => e.name);
          const wanted = [
            setNames.length === 0 ? null : `置く: ${setNames.join(', ')}`,
            removedNames.length === 0 ? null : `外す: ${removedNames.join(', ')}`,
          ]
            .filter((part) => part !== null)
            .join('。');

          await deps.stores.journal.append({
            type: 'decision',
            decision: `環境変数（鍵）を差し替えようとしている（${wanted}）`,
            grounds: `${describeActor(c.get('principal'))}（PUT /credentials）。値は書かない（鍵そのものである）。`,
          });

          let result: ApplyCredentialsResult;
          try {
            result = await deps.credentials.apply(entries);
          } catch (error) {
            // 理由を返す: 「置けなかった」だけでは、人間は名前を疑うのか権限を疑うのか分からない。返してよいのは検証で断った例外（名前と理由だけで値を載せない文）の型だけ: `apply` は保存も担うので、それ以外の `message` には値が載りうる（drizzle は `Failed query: … params: <値>` を添える）。見分けは文言でなく型で行い、それ以外は `name` だけを応答にも日誌にも載せる。
            const reason =
              error instanceof CredentialEntryRejectedError
                ? error.message
                : error instanceof NulNotAllowedError
                  ? error.message
                  : error instanceof InvalidCredentialNameError
                    ? error.message
                    : `鍵の差し替えに失敗した（${kindOfError(error)}）。詳細は値が載りうるので返さない`;
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: `環境変数（鍵）を差し替えられなかった（${wanted}）`,
                grounds:
                  `${describeActor(c.get('principal'))}（PUT /credentials、状態の変更が失敗）: ` +
                  reason,
              },
              '環境変数（鍵）の打ち消しの日誌',
              `names=${entries.map((e) => e.name).join(',')}`,
            );
            return c.json({ error: reason }, 400);
          }

          // `result.fingerprints` を丸ごと流さない: `secret === false` の行は `value`（平文）を伴って返ってくるので、`name` / `sha256` だけを個別に読む。
          const sha256ByName = new Map(result.fingerprints.map((f) => [f.name, f.sha256]));
          const changed = [
            setNames.length === 0
              ? null
              : `置いた: ${setNames.map((name) => `${name}=${sha256ByName.get(name) ?? '不明'}`).join(', ')}`,
            removedNames.length === 0 ? null : `外した: ${removedNames.join(', ')}`,
          ]
            .filter((part) => part !== null)
            .join('。');
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `環境変数（鍵）を差し替えた（${changed}）`,
              grounds:
                `${describeActor(c.get('principal'))}（PUT /credentials）。` +
                '値は書かない（鍵そのものである）。' +
                `runner への配布: ${describePluginDelivery(result.runners)}` +
                '。',
            },
            '環境変数（鍵）の日誌',
            `names=${entries.map((e) => e.name).join(',')}`,
          );

          return c.json(
            // サービスの返す形をそのまま流さない: 宣言（`credentials`）とサービスの語彙（`fingerprints`）が違うので `parse` で落ちる形にしておく。
            credentialsUpdateResponseSchema.parse({
              credentials: result.fingerprints,
              runners: result.runners,
              restartRequired: result.restartRequired,
            }),
          );
        },
      )

      // 値（auth.json の中身）を返す口は作らない: 状態とログインの進み具合だけを返す。
      .get(
        '/codex/auth',
        describeRoute({
          tags: ['codex'],
          summary: 'Codex の ChatGPT ログインの状態を読む',
          description:
            'ログイン済みか・アカウント・プラン・最終更新・指紋・最後の失敗を返す。**値は返さない。**',
          responses: {
            200: jsonResponse('いまの状態。', codexAuthStatusResponseSchema),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        async (c) => {
          if (deps.codexAuth === undefined) {
            return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
          }
          return c.json(codexAuthStatusResponseSchema.parse(await deps.codexAuth.status()));
        },
      )

      // 狭める側なので、日誌は状態を変えた後に持ち主（`CodexChatgptAuthService`）が書く。資格は `PUT /credentials` と揃える（資格を書く口であるため）。
      .delete(
        '/codex/auth',
        describeRoute({
          tags: ['codex'],
          summary: 'Codex の ChatGPT ログインを消す（ログアウト）',
          description: '正本から消し、全 runner の CODEX_HOME から外す。',
          responses: {
            200: jsonResponse('消したか（無かったなら false）。', codexLogoutResponseSchema),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        async (c) => {
          if (deps.codexAuth === undefined) {
            return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
          }
          return c.json(codexLogoutResponseSchema.parse(await deps.codexAuth.logout()));
        },
      )

      // 能力を広げる口（peer の Codex が使う資格を置く）なので、`PUT /credentials` と同じく許可済みのアカウントだけを通し、日誌を先に書く（書けなければ始めずに 500）。
      .post(
        '/codex/login',
        describeRoute({
          tags: ['codex'],
          summary: 'Codex の ChatGPT ログインをデバイスコードで始める',
          description:
            'デーモンの器で codex app-server を一時的な CODEX_HOME で起こし、デバイスコードを回す。' +
            '返った verificationUrl を開いて userCode を入力すると完了する。',
          responses: {
            200: jsonResponse(
              '始めたログイン（または進行中のログイン）。',
              codexLoginResponseSchema,
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            502: errorResponse('codex app-server を起こせなかった・デバイスコードを取れなかった。'),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        async (c) => {
          if (deps.codexAuth === undefined) {
            return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
          }
          await deps.stores.journal.append({
            type: 'decision',
            decision: 'Codex の ChatGPT ログインを始めようとしている（デバイスコード）',
            grounds: `${describeActor(c.get('principal'))}（POST /codex/login）。値は書かない。`,
          });
          try {
            return c.json(codexLoginResponseSchema.parse(await deps.codexAuth.startLogin()));
          } catch (error) {
            return c.json({ error: reasonOf(error) }, 502);
          }
        },
      )

      .get(
        '/codex/login/:id',
        describeRoute({
          tags: ['codex'],
          summary: 'Codex の ChatGPT ログインの進み具合を読む',
          responses: {
            200: jsonResponse('ログイン1本の状態。', codexLoginResponseSchema),
            404: errorResponse('知らない id（デーモンが入れ替わった・古くて忘れた）。'),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        (c) => {
          if (deps.codexAuth === undefined) {
            return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
          }
          const view = deps.codexAuth.login(c.req.param('id'));
          if (view === undefined) return c.json({ error: 'そのログインは無い' as const }, 404);
          return c.json(codexLoginResponseSchema.parse(view));
        },
      )

      .delete(
        '/codex/login/:id',
        describeRoute({
          tags: ['codex'],
          summary: 'Codex の ChatGPT ログインを取り消す',
          responses: {
            200: jsonResponse(
              '取り消した後の状態（既に決着していればその状態）。',
              codexLoginResponseSchema,
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            404: errorResponse('知らない id。'),
            503: errorResponse(CANONICAL_STORE_MISSING_DESCRIPTION),
          },
        }),
        async (c) => {
          if (deps.codexAuth === undefined) {
            return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
          }
          const view = await deps.codexAuth.cancelLogin(c.req.param('id'));
          if (view === undefined) return c.json({ error: 'そのログインは無い' as const }, 404);
          return c.json(codexLoginResponseSchema.parse(view));
        },
      )
  );
}
