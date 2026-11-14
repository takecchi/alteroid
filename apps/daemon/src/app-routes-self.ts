import {
  createSecretRedactor,
  ROTATABLE_CREDENTIAL_KEYS,
  WITHHELD_ENV_KEYS,
  writeStderrLine,
} from '@alteroid/core';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import { AUTH_WITHHELD_ENV_KEYS, type AuthVariables } from './auth.js';
import { selfPromptResponseSchema } from './openapi.js';
import { buildSelfPromptBody, finalizeSelfPrompt } from './self-prompt.js';
import {
  INVALID_QUERY_DESCRIPTION,
  errorResponse,
  invalidWith,
  jsonResponse,
  queryParams,
} from './app-shared.js';

// `1`/`0` 以外は 400 で断る（黙って既定にしない）: `full=false` のような綴りの違いが全文返しに化けると、大きさだけを取りたい呼びが全文を受け取る。`z.coerce.boolean()` を使わない（`?full=false` が true になる）。
const selfPromptQuery = z.object({ full: z.enum(['1', '0']).default('1') });

// 応答を返さずに断る本文。理由の文（例外のメッセージ）は載せない: 走査の途中で落ちた例外が、走査できていない値を抱えているかもしれないため。
const SCAN_FAILED_BODY = {
  error: '秘密走査を完了できなかったので、応答を返さない（走査できていない全文を返さないため）',
} as const;

export function selfRoutes(ctx: AppContext, deps: AppDeps) {
  const { clone } = ctx;

  return new Hono<{ Variables: AuthVariables }>().get(
    '/self/prompt',
    describeRoute({
      tags: ['self'],
      summary: 'クローンが実際に焼いたプロンプトを読む（読み取り専用）',
      description:
        'クローンが**いま実際に焼いている**システムプロンプト全文・記憶の索引の中身・道具の説明と入力スキーマ・' +
        '外部 MCP の登録（名前と種別だけ）・プラグイン（名前だけ）・直近のターン境界の文脈占有を返す。' +
        '**メモリ上の1件を読むだけで、何も書かない**（日誌にもファイルにも書かない。再起動後は次のセッションが始まるまで `session: null`）。' +
        '資格は他の口と同じ（アクセストークンも実行環境の持ち主も通る。新しい資格・スコープは無い）。**連携の鍵（`altk_`）は通らない**（既定で拒否）。' +
        '`full=1`（既定）は全文を返し、`full=0` は `systemPrompt.text`・`tools[].description`・`tools[].inputSchema` を省いて大きさ（`chars` 系）だけを返す。' +
        '`1`/`0` 以外は 400（黙って既定にしない）。' +
        '**取れない軸は 0 や空配列にせず `null` にして、理由を `notice` に書く**（まだセッションが組まれていない・組み立てに失敗した・ターン境界をまだ観測していない）。' +
        '`memoryInPrompt[].indexChars` は、焼いた索引の中でその文書が占めた断片の長さ（カードは要旨＋節の目次、fact は目次の1行）。' +
        '索引から省かれた文書は `omitted: true` で `indexChars: null`、理由は `indexNote`。' +
        'SDK 組み込みの道具の定義（説明・入力スキーマ）は取れない（`builtinTools.reason`）。名前と大きさだけは `builtinTools.systemTools` / `deferredBuiltinTools` に在る。' +
        '**外部 MCP の接続設定の値（url・args・env・headers・command）は返さない**（`GET /mcp-servers` は値を含むので、ここでは使わない）。' +
        '**返す全部の文字列を応答を返す直前に1回走査し、鍵らしい値は `[redacted:<規則名>]` に置き換える**' +
        '（連携の鍵・GitHub・Anthropic/OpenAI・AWS・Bearer・JWT・PEM 秘密鍵・デーモン自身の秘密の環境変数の値など）。' +
        '当たった規則の名前と件数だけを `secretScan` と `notice` に出し、値・位置・前後の文脈は出さない。当たり0件でも「走査した」を出す。' +
        '**走査が落ちたら応答を返さずに 500**（走査できていない全文を返さない）。',
      responses: {
        200: jsonResponse(
          'クローンが焼いたプロンプトの内容。取れていない軸は `null`（理由は `notice`）。',
          selfPromptResponseSchema,
        ),
        400: errorResponse(`${INVALID_QUERY_DESCRIPTION}（\`full\` は \`1\` か \`0\` だけ）`),
        401: errorResponse('資格が無い。'),
        500: errorResponse('秘密走査を完了できなかった（応答は返さない。本文に理由は載せない）。'),
      },
    }),
    queryParams(selfPromptQuery, invalidWith('クエリが不正（full は 1 か 0 だけ）')),
    (c) => {
      const { full } = c.req.valid('query');
      try {
        const body = finalizeSelfPrompt(
          buildSelfPromptBody(clone.promptSnapshot(), { full: full === '1' }),
          // 既知の秘密名は既存の一覧を使う（新しい一覧を手書きしない）。名前に TOKEN・KEY などが入る変数は、走査の側が拾う
          createSecretRedactor({
            env: deps.env ?? process.env,
            knownSecretEnvNames: [
              ...WITHHELD_ENV_KEYS,
              ...AUTH_WITHHELD_ENV_KEYS,
              ...ROTATABLE_CREDENTIAL_KEYS,
            ],
          }),
        );
        return c.json(body);
      } catch (error) {
        // 例外のメッセージは出さない（名前だけ）: 走査に使う値を抱えた例外が器の外へ出ないように
        writeStderrLine(
          `alteroidd: GET /self/prompt の秘密走査か組み立てに失敗したので応答を返さない（${error instanceof Error ? error.name : typeof error}）\n`,
        );
        return c.json(SCAN_FAILED_BODY, 500);
      }
    },
  );
}
