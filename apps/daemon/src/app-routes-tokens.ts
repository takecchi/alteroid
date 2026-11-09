import type { TokenPoolService } from '@alteroid/core';
import {
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  classifyTokenPolicyChange,
  classifyTokenPoolChange,
  TokenPoolInputError,
  TokenPoolVersionMismatchError,
  noteDroppedRecord,
  redactErrorText,
  tokenRotationSettingsSchema,
  UnreadableActiveTokenError,
  type TokenPolicyChange,
  type TokenPoolChange,
} from '@alteroid/core';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  errorResponseSchema,
  journalWriteFailedResponseSchema,
  tokensPolicyUpdateRequestSchema,
  tokensConflictResponseSchema,
  tokensListResponseSchema,
  tokensReplaceResponseSchema,
  tokensResponseSchema,
  tokensUnreadableRemoveRequestSchema,
  tokensUnreadableRemoveResponseSchema,
  tokensUpdateRequestSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  LOGGED_IN_WITHOUT_GRANT_DESCRIPTION,
  JOURNAL_FAILED_OR_REMOVE_FAILED_DESCRIPTION,
  UNREADABLE_IDS_MISSING_DESCRIPTION,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  invalidWith,
  jsonBody,
  describeActor,
  appendJournalOrDrop,
  journalWriteFailedBody,
  kindOfError,
} from './app-shared.js';

// id・ラベル・操作の種類だけで、トークンの値も指紋も書かない。
function describeTokenPoolChanges(changes: readonly TokenPoolChange[]): string {
  const names = {
    add: '追加',
    remove: '削除',
    disable: '無効化',
    enable: '有効化',
    rename: '改名',
  };
  return changes
    .map((change) => {
      const kind =
        change.operation === 'switch'
          ? change.reason === 'value'
            ? '切替（値の差し替え）'
            : '切替（試す順の入れ替え）'
          : names[change.operation];
      return `${kind}: ${change.label}（id: ${change.id}）`;
    })
    .join('、');
}

function describeTokenPolicyChanges(changes: readonly TokenPolicyChange[]): string {
  return changes
    .map((change) => `${change.field}: ${change.from ?? '読めなかった'} → ${change.to}`)
    .join('、');
}

export function tokensRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 資格は `authenticate` だけ: ここが持つのは課金の設定であって鍵の値ではない（`/profile` とは違う）。値は決して出さない: `AgentToken`（`value` 付き）はサービスの外へ一度も出ない。
      .get(
        '/tokens',
        describeRoute({
          tags: ['tokens'],
          summary: '認証トークンのプールと設定を読む',
          description:
            'プールが空でも 200 を返し、既定の設定（`free_exhausted`）を返す' +
            '（受け入れ基準7: プールが空の既定構成の挙動を変えない）。' +
            '回す契機・冷却の設定が壊れていて読めないときも 200 を返す——' +
            '`settings` を省いて `settingsUnreadable.reason` を返す（issue #2095）。' +
            'プールの行が読めない（版ずれ・手編集）ものが在るときだけ、`rowsUnreadable`' +
            '（件数と、id・ラベル・不正な欄名。**値は含まない**）が載る。**壊れた行であって、' +
            '消されたトークンではない。** `tokens` が空でも `rowsUnreadable` が在れば' +
            '「登録されていない」ではない。0件なら鍵ごと無い（issue #2346）。' +
            '現役の指名（いま効いている鍵）は3つの状態を別の欄で返す: 在るとき `active`' +
            '（`tokenId`・`generation`・`rotatedAt`）、まだ一度も無い（何も撒いていない。器の環境変数へは倒れない）ときは' +
            ' `activeNever: true`、読めないときは `activeUnreadable.reason`。どれも無いのは現役を返さない' +
            '古いデーモン。読めなくても一覧は道連れにしない。' +
            '`loads` は鍵ごとの枠の最後の観測（デーモンのメモリにだけ在る。#6633）で、' +
            '測っていない鍵の行は無い（0% で埋めない）。',
          responses: {
            200: jsonResponse(
              'プール（値は出さない）と設定。設定が読めないときは `settings` の代わりに' +
                '`settingsUnreadable: { reason }` を返す（プールの一覧は道連れにしない）。' +
                '行が読めないものが在るときは `rowsUnreadable` も載る。' +
                '現役の指名は `active` / `activeNever` / `activeUnreadable` のどれか1つが載る。',
              tokensListResponseSchema,
            ),
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
          },
        }),
        async (c) => {
          if (deps.tokens === undefined) {
            return c.json(
              tokensResponseSchema.parse({ tokens: [], settings: DEFAULT_TOKEN_ROTATION_SETTINGS }),
            );
          }
          const view = await deps.tokens.list();
          // `list()` と素の `Promise.all` にしない: 現役が読めないだけで一覧まで道連れにしないため（道具 `token_list` と同じ作法）。読めないとき `activeNever` へ倒さない: 「まだ一度も無い」という別の意味になるため
          let activeFields: Pick<
            z.infer<typeof tokensListResponseSchema>,
            'active' | 'activeNever' | 'activeUnreadable'
          >;
          try {
            const active = await deps.stores.tokens.readActive();
            activeFields = active === null ? { activeNever: true } : { active };
          } catch (error) {
            if (!(error instanceof UnreadableActiveTokenError)) throw error;
            // `redactErrorText` を通す: 理由は Web・CLI がそのまま出す。`reasonOf` は型名で包むので使わない
            activeFields = {
              activeUnreadable: { reason: redactErrorText(error.message, process.env) },
            };
          }
          const loads = deps.tokenLoads?.();
          return c.json(
            tokensListResponseSchema.parse({
              ...view,
              ...activeFields,
              ...(loads === undefined ? {} : { loads }),
            }),
          );
        },
      )

      // 理由の本文にトークンの値は含めない（投げるメッセージは id / label だけを含む）。
      .put(
        '/tokens',
        describeRoute({
          tags: ['tokens'],
          summary: '認証トークンのプールを全文置換する',
          description:
            '入力に無い（読めた）行は消える。**読めない行は消さずに持ち越す**（issue #2354。' +
            '消すには `POST /tokens/unreadable/remove`）。壊れた入力（新規行に value が無い・消えた id を' +
            '指す・id 重複）は 400 で理由を返し、保存しない。' +
            '`ifMatch`（`GET /tokens` の `version`）を渡すと、読んだ後にプールが変わっていたとき' +
            '（ほかで足した・消した・改名した・無効化した・順を変えた）何も変えずに 409 を返す。' +
            '省けば今までどおり比べない（回し手の冷却の書き戻しでは版は変わらない）。',
          responses: {
            200: jsonResponse(
              '置き換え後のプール（値は出さない）と設定。設定が読めないときは `settings` の' +
                '代わりに `settingsUnreadable: { reason }` を返す（プールの置換は道連れにしない。' +
                'issue #2095）。読めない行が在れば `rowsUnreadable`（`carriedOver: true`）が載る——' +
                '**読めない行は捨てずに持ち越した**（issue #2354）。消すには ' +
                '`POST /tokens/unreadable/remove`。**保存した後の表示の読み直しに失敗したときも ' +
                '200**（保存したので「保存できなかった」とは言わない）: `viewUnavailable` だけを' +
                '返し、プールの欄（`tokens` など）は載せない。',
              tokensReplaceResponseSchema,
            ),
            400: errorResponse('入力が壊れている（保存していない）。'),
            409: jsonResponse(
              '`ifMatch` がいまのプールの版と食い違う（読んだ後に変わった。何も変えていない）。' +
                '`current` にいまのプール（値は出さない）を添える。読み直して、やり直す。',
              tokensConflictResponseSchema,
            ),
            500: {
              description:
                '保存に失敗した、または**広げる側の変更（追加・有効化・値の差し替え・試す順の入れ替え）で' +
                '日誌が書けなかった（保存していない）**。狭める側（削除・無効化・改名）だけの変更は、' +
                '日誌が書けなくても保存して 200 を返す（issue #2742）。' +
                '**理由の本文は返さない**（ドライバの例外は失敗した' +
                'クエリの束縛パラメータを添えてくることがあるため）。跡は stderr に残る。' +
                '日誌が書けなかった回の本文は `{ error: "記録（日誌）が書けなかったので、変更していません", code: "journal_write_failed" }`' +
                '（`code` で見分ける。保存の失敗は `code` の無い `{ error }`）。',
              content: {
                'application/json': {
                  schema: resolver(
                    z.union([journalWriteFailedResponseSchema, errorResponseSchema]),
                  ),
                },
              },
            },
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
          },
        }),
        // 既定の 400 を使わない: `hook` を渡さないと `@hono/standard-validator` が本文そのものを `data` に載せて返し（`RESTRICTED_DATA_FIELDS` は cookie だけで `json` は素通し。`@hono/standard-validator@0.4.0` で観測）、`label` を1つ書き忘れただけでその回に送った全部の値が応答へ載る。返すのは `path` だけ。
        jsonBody(
          tokensUpdateRequestSchema,
          invalidWith('トークンのプールの入力の形が不正（保存していない）'),
        ),
        async (c) => {
          if (deps.tokens === undefined) {
            return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
          }
          // 能力の向きで日誌の順序を分ける: 広げる側（追加・有効化・切替）が差分に1つでも在れば日誌が先で、書けなければ保存せずに 500（使える鍵が増える・変わる操作を記録の無いまま通さない）。狭める側だけ（削除・無効化・改名）なら保存が先で、日誌が書けなくても止めない。全文置換なので前後の差分から分類する。
          const state: {
            changes: TokenPoolChange[];
            written: boolean;
            journalError?: { cause: unknown };
          } = { changes: [], written: false };
          const requestedCount = c.req.valid('json').tokens.length;
          let saved: Awaited<ReturnType<TokenPoolService['replace']>>;
          try {
            const { ifMatch } = c.req.valid('json');
            saved = await deps.tokens.replace(c.req.valid('json').tokens, {
              ...(ifMatch === undefined ? {} : { ifMatch }),
              beforeSave: async ({ before, after }) => {
                state.changes = classifyTokenPoolChange(before, after);
                if (!state.changes.some((change) => change.widens)) return;
                try {
                  await deps.stores.journal.append({
                    type: 'decision',
                    decision: `認証トークンのプールを変えようとしている（${describeTokenPoolChanges(state.changes)}）`,
                    grounds:
                      `${describeActor(c.get('principal'))}（PUT /tokens）。` +
                      '使える鍵が増える・変わる操作を含むので、日誌を先に書いた。' +
                      'id・ラベル・操作の種類だけを書く（トークンの値は書かない）。',
                  });
                } catch (cause) {
                  state.journalError = { cause };
                  throw cause;
                }
                state.written = true;
              },
            });
          } catch (error) {
            // 素の 500 にせず「記録が書けなかったので変更していない」と言う本文を返す。例外の本文は返さない（値が載りうる）。
            if (state.journalError !== undefined) {
              noteDroppedRecord(
                '認証トークンのプールの変更の日誌（保存していない）',
                `count=${String(requestedCount)}`,
                kindOfError(state.journalError.cause),
              );
              return c.json(journalWriteFailedBody(), 500);
            }
            // 返してよい例外だけを型で分けて返す: `TokenPoolInputError` は `message` をそのまま返してよいという約束が型に付いている。それ以外（保存の失敗）は本文を1文字も返さない: ドライバの例外は失敗したクエリの束縛パラメータを添えるので（`drizzle-orm@0.45.2` の `PgPreparedQuery` は `Failed query: …` の次の行に `params: …` を置く）、素の `String(error)` を返すとトークンの値が載る。`reasonOf` を通すだけにしない: 1行目だけを採って値が落ちるのは、ドライバの改行位置に依存した偶然。投げ直さない: 既定のハンドラへ回るだけで、本文を出さない保証が消える。
            if (error instanceof TokenPoolInputError) {
              return c.json({ error: error.message }, 400);
            }
            // 版の食い違いは書く前に断っている（日誌も書いていない）。いまの姿を添える: 読めなければ省く（409 は変えない）
            if (error instanceof TokenPoolVersionMismatchError) {
              let current: z.infer<typeof tokensResponseSchema> | undefined;
              try {
                current = tokensResponseSchema.parse(await deps.tokens.list());
              } catch {
                current = undefined;
              }
              return c.json(
                tokensConflictResponseSchema.parse({
                  error: '認証トークンのプールが読んだ後に変わっている（変えていない）',
                  ...(current === undefined ? {} : { current }),
                }),
                409,
              );
            }
            // 日誌は先に書いたが保存できなかったので、打ち消しの行を足す（`PUT /credentials` と同じ形）。
            if (state.written) {
              await appendJournalOrDrop(
                deps.stores,
                {
                  type: 'decision',
                  decision: '認証トークンのプールを変えられなかった',
                  grounds:
                    `${describeActor(c.get('principal'))}（PUT /tokens、状態の変更が失敗）。` +
                    `先に書いた行の変更（${describeTokenPoolChanges(state.changes)}）は保存されていない。`,
                },
                '認証トークンのプールの打ち消しの日誌',
                `count=${String(requestedCount)}`,
              );
            }
            // error は種類（`name`）だけ渡す: `noteDroppedRecord` は `message` の1行目と `cause` の連鎖を stderr へ出すので、生の error を渡すとエラー文に載ったトークンの値が出うる。
            noteDroppedRecord(
              '認証トークンのプール',
              `count=${String(requestedCount)}`,
              kindOfError(error),
            );
            return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
          }
          // 狭める側だけの変更は保存した後に日誌を書き、書けなければ跡だけ残して握る（広げる側を含む回は保存の前に書いてある）。
          if (!state.written && state.changes.length > 0) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: `認証トークンのプールを変えた（${describeTokenPoolChanges(state.changes)}）`,
                grounds:
                  `${describeActor(c.get('principal'))}（PUT /tokens）。` +
                  '狭める側（削除・無効化・改名）だけの変更なので、保存の後に書いた。' +
                  'id・ラベル・操作の種類だけを書く（トークンの値は書かない）。',
              },
              '認証トークンのプールの変更の日誌',
              `count=${String(requestedCount)}`,
            );
          }
          // ここから先は保存した後: 失敗しても「保存できなかった」ではないので、上の `catch`（500）へ落とさず保存したと言って返す。原因は種類（`error.name`）だけを日誌に使う: メッセージには行の中身（トークンの値）が載りうる。
          let cause: unknown;
          if (saved.kind === 'replaced') {
            try {
              return c.json(tokensReplaceResponseSchema.parse(saved.view));
            } catch (parseError) {
              cause = parseError;
            }
          } else {
            cause = saved.cause;
          }
          // 変更そのものの日誌は上で書いてある: この1行は保存の後の読み直しの失敗の跡で best-effort。
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: '認証トークンのプールを保存したが、表示の読み直しに失敗した',
              grounds:
                `${describeActor(c.get('principal'))}（PUT /tokens）。` +
                `保存は済んでいる。読み直しの失敗の種類: ${kindOfError(cause)}。` +
                '行の中身（トークンの値）は書かない。',
            },
            '認証トークンのプールの保存後の読み直しの失敗の日誌',
            `count=${String(c.req.valid('json').tokens.length)}`,
          );
          return c.json(
            tokensReplaceResponseSchema.parse({
              viewUnavailable: {
                reason:
                  '保存した。保存後のプールを読み直せなかった' +
                  '（撃ち直さず、alteroid token list で今の姿を確かめる）',
              },
            }),
          );
        },
      )

      // `PUT /tokens` と回し手の書き戻しは読めない行を持ち越すので、消す口はここだけ。読めない行は `:id`（読めた行の id）と名前空間が重なりうるので別の語（`unreadable`）の下に置く。日誌を先に書き、書けなければ状態を変えずに 500。日誌に残すのは消す id と件数だけ（とくにトークンの値は書かない）。
      .post(
        '/tokens/unreadable/remove',
        describeRoute({
          tags: ['tokens'],
          summary: '読めない認証トークンの行を、id を指して消す',
          description:
            '`GET /tokens` の `rowsUnreadable.rows[].id` を指した読めない行だけを消す。読めた行・' +
            '設定には触れない。id が取れない行はこの口では消せない。1つでも読めない行に無い id が' +
            'あれば何も消さない。消した id と件数を日誌に残す（行の中身は残さない）。',
          responses: {
            200: jsonResponse(
              '消した後のプール（値は出さない）と、消した id。**消した後の表示の読み直しに' +
                '失敗したときも 200**（消したので「消せなかった」とは言わない）: `removedIds` と ' +
                '`viewUnavailable` だけを返し、プールの欄は載せない。',
              tokensUnreadableRemoveResponseSchema,
            ),
            400: errorResponse(
              'トークンのプールの器が無い、または入力の形が不正（何も消していない）。',
            ),
            404: errorResponse(UNREADABLE_IDS_MISSING_DESCRIPTION),
            500: errorResponse(JOURNAL_FAILED_OR_REMOVE_FAILED_DESCRIPTION),
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
          },
        }),
        jsonBody(
          tokensUnreadableRemoveRequestSchema,
          invalidWith('読めない行の id の入力の形が不正（何も消していない）'),
        ),
        async (c) => {
          if (deps.tokens === undefined) {
            return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
          }
          const requested = c.req.valid('json').ids;
          // `let` ではなく入れ物にする: 閉じ込めで代入するので型の絞り込みが `never` に倒れる。
          const written: { detail?: string } = {};
          try {
            const result = await deps.tokens.removeUnreadable(requested, {
              // 日誌を先に書く: 書けなければここで投げ、状態を変えずに `base.onError` へ抜ける。トークンの値は書かない。
              beforeRemove: async (ids) => {
                await deps.stores.journal.append({
                  type: 'decision',
                  decision: `読めない認証トークンの行を ${String(ids.length)} 件消そうとしている（id: ${ids.join(', ')}）`,
                  grounds:
                    `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove）。` +
                    '消すのは id で指した読めない行だけ。行の中身（トークンの値）は書かない。',
                });
                written.detail = `ids=${ids.join(',')}`;
              },
            });
            if (result.kind === 'unknown') {
              return c.json(
                {
                  error:
                    `指した id のうち ${String(result.count)} 件が、読めない行に無い` +
                    '（何も消していない。alteroid token list で読めない行の id を確かめる）',
                },
                404,
              );
            }
            // ここから先は行を消した後: 失敗しても「消せなかった」ではないので、下の `catch`（打ち消しと 500）へ落とさず消したと言って返す。原因は種類だけを日誌に使う（メッセージにはトークンの値が載りうる）。
            let cause: unknown;
            if (result.kind === 'removedViewFailed') {
              cause = result.cause;
            } else {
              try {
                return c.json(
                  tokensUnreadableRemoveResponseSchema.parse({
                    ...result.view,
                    removedIds: result.ids,
                  }),
                );
              } catch (parseError) {
                cause = parseError;
              }
            }
            const kindOfCause = cause instanceof Error ? cause.name : typeof cause;
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: `読めない認証トークンの行を消した（id: ${result.ids.join(', ')}）が、表示の読み直しに失敗した`,
                grounds:
                  `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove）。` +
                  `行は消えている。読み直しの失敗の種類: ${kindOfCause}。` +
                  '行の中身（トークンの値）は書かない。',
              },
              '読めない認証トークンの行の削除後の読み直しの失敗の日誌',
              `ids=${result.ids.join(',')}`,
            );
            return c.json(
              tokensUnreadableRemoveResponseSchema.parse({
                removedIds: result.ids,
                viewUnavailable: {
                  reason:
                    '読めない行は消した。消した後のプールを読み直せなかった' +
                    '（alteroid token list で今の姿を確かめる）',
                },
              }),
            );
          } catch (error) {
            // 日誌が書けなかった回は状態を変えていないので、投げ直して `base.onError` の 500 に任せる。
            const journaled = written.detail;
            if (journaled === undefined) throw error;
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: '読めない認証トークンの行を消せなかった',
                grounds:
                  `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove、` +
                  `状態の変更が失敗）。${journaled}`,
              },
              '読めない認証トークンの行の打ち消しの日誌',
              journaled,
            );
            // error は種類（`name`）だけ渡す: 生の error を渡すと `noteDroppedRecord` が `message` の1行目を stderr へ出し、エラー文に載ったトークンの値が出うる。
            noteDroppedRecord('読めない認証トークンの行の削除', journaled, kindOfError(error));
            return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
          }
        },
      )

      .put(
        '/tokens/policy',
        describeRoute({
          tags: ['tokens'],
          summary: '回す契機・冷却の既定を変える',
          description:
            '省略した項目は現状のまま変えない。変更は日誌に残る（issue #2742）。回す契機を有効にする・' +
            '変える・冷却を変える変更は**日誌を先に書き、書けなければ保存せず 500**。' +
            '`rotateOn: off` へ狭める変更は保存が先で、日誌が書けなくても保存する。' +
            '`distribution` は `balanced` なら同じコンテナ（runner・クローン）に同じ鍵を使い続け、混み具合が 90% を超えたら新しい作業から空いている鍵へ移す（既定は `balanced`）。' +
            '`balanced` へ変える変更は日誌が先、`failover` へ戻す変更は保存が先。',
          responses: {
            200: jsonResponse('更新後の設定。', tokenRotationSettingsSchema),
            500: journalWriteFailedResponse(
              '日誌が書けなかった（**保存していない**。広げる側の変更のとき）。本文は ' +
                '`{ error: "記録（日誌）が書けなかったので、変更していません", code: "journal_write_failed" }`。',
            ),
            400: errorResponse('トークンのプールの器が配線されていない。'),
            403: errorResponse(LOGGED_IN_WITHOUT_GRANT_DESCRIPTION),
          },
        }),
        jsonBody(tokensPolicyUpdateRequestSchema, invalidWith('設定の入力の形が不正')),
        async (c) => {
          if (deps.tokens === undefined) {
            return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
          }
          // 能力の向きで日誌の順序を分ける: 回さない方向へ狭めるだけ（変更後の `rotateOn` が `off`）なら保存が先で、「止める」を日誌の失敗で止めない。それ以外（契機を有効にする・変える、冷却を変える）は日誌が先で、書けなければ保存せずに 500（冷却の長短は判断が割れるので安全側＝広げる側に倒す）。差分が無ければ日誌は書かない。
          const policyState: {
            changes: TokenPolicyChange[];
            widens: boolean;
            written: boolean;
            journalError?: { cause: unknown };
          } = { changes: [], widens: false, written: false };
          let settings: Awaited<ReturnType<TokenPoolService['setSettings']>>;
          try {
            settings = await deps.tokens.setSettings(c.req.valid('json'), {
              beforeWrite: async ({ before, after }) => {
                const classified = classifyTokenPolicyChange(before, after);
                policyState.changes = classified.changes;
                policyState.widens = classified.widens;
                if (!classified.widens) return;
                try {
                  await deps.stores.journal.append({
                    type: 'decision',
                    decision: `トークンを回す設定を変えようとしている（${describeTokenPolicyChanges(classified.changes)}）`,
                    grounds:
                      `${describeActor(c.get('principal'))}（PUT /tokens/policy）。` +
                      '回す契機を有効にする・変える（または冷却を変える）操作なので、日誌を先に書いた。',
                  });
                } catch (cause) {
                  policyState.journalError = { cause };
                  throw cause;
                }
                policyState.written = true;
              },
            });
          } catch (error) {
            if (policyState.journalError !== undefined) {
              noteDroppedRecord(
                'トークンを回す設定の変更の日誌（保存していない）',
                policyState.changes.map((change) => change.field).join(','),
                kindOfError(policyState.journalError.cause),
              );
              return c.json(journalWriteFailedBody(), 500);
            }
            if (policyState.written) {
              await appendJournalOrDrop(
                deps.stores,
                {
                  type: 'decision',
                  decision: 'トークンを回す設定を変えられなかった',
                  grounds:
                    `${describeActor(c.get('principal'))}（PUT /tokens/policy、状態の変更が失敗）。` +
                    `先に書いた行の変更（${describeTokenPolicyChanges(policyState.changes)}）は保存されていない。`,
                },
                'トークンを回す設定の打ち消しの日誌',
                policyState.changes.map((change) => change.field).join(','),
              );
            }
            throw error;
          }
          if (!policyState.written && policyState.changes.length > 0) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: `トークンを回す設定を変えた（${describeTokenPolicyChanges(policyState.changes)}）`,
                grounds:
                  `${describeActor(c.get('principal'))}（PUT /tokens/policy）。` +
                  '回さない方向（rotateOn: off）へ狭める変更なので、保存の後に書いた。',
              },
              'トークンを回す設定の変更の日誌',
              policyState.changes.map((change) => change.field).join(','),
            );
          }
          return c.json(tokenRotationSettingsSchema.parse(settings));
        },
      )
  );
}
