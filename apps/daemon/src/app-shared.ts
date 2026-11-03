import type { JournalEntry, JournalEntryInput, Stores } from '@alteroid/core';
import {
  UnreadableJournalEntryError,
  noteDroppedRecord,
  stripNul,
  type AnswerApprovalVia,
  type HumanAction,
  type HumanActionKind,
  type RemoveUnreadableRowsOptions,
  type RemoveUnreadableRowsResult,
} from '@alteroid/core';
import { type AuthVariables, type Principal } from './auth.js';
import type { Env } from 'hono';
import { createFactory, createMiddleware } from 'hono/factory';
import { describeRoute, resolver, validator } from 'hono-openapi';
import { z } from 'zod';
import {
  errorResponseSchema,
  JOURNAL_WRITE_FAILED_CODE,
  JOURNAL_WRITE_FAILED_MESSAGE,
  journalWriteFailedResponseSchema,
  unreadableRowsRemoveRequestSchema,
  unreadableRowsRemoveResponseSchema,
} from './openapi.js';

// `export` した関数の戻り型は宣言出力（tsup の dts）で名前を付けられる必要がある: 推論のままだと
// `hono-openapi` の内部の型（`JSONSchema7` など）を指して TS2883 になるので、注釈で与える（型だけ。値は変えない）。
type JsonResponse = {
  description: string;
  content: { 'application/json': { schema: ReturnType<typeof resolver> } };
};

// `app.ts` の経路が複数の族にまたがって使う共有物（応答ヘルパ・検証の包み・日誌ヘルパ・未読行の削除など）。
// `openapi.ts` の値を最上位で評価しない（`app.ts` ↔ `openapi.ts` は循環 import）。`app.ts` を値で import しない。

// 書き込みの `ifMatch`: 省略は後勝ち、`null` は「まだ無いこと」を前提にする（読んだ版を前提にする書き込みの共通の欄）。
export const ifMatchField = z.string().nullable().optional();

// `ifMatch` の省略は 428 で断るが形の検査では必須にしない: スラッグ不正 400・無い 404 を先に返すためハンドラで 404 の後に断る。`null` は受けない（無いものを消す意味が無い）。
// やり方の削除も同じ形（読めない形で入っている行だけは版なしで消せる）。
export const ifMatchDeleteQuery = z.object({ ifMatch: z.string().min(1).optional() });

// 127.0.0.1 で待つことはブラウザからの保護にならない: 任意のページから `no-cors` の fetch や HTML form（CORS の単純リクエスト）で POST でき、応答が読めなくても送信は成立する。`application/json` を要求すると preflight が必須になり、CORS ヘッダを返さないこのデーモンでは通らない（能力を削らず実行環境の境界で塞ぐ。north_star 禁止2）。本文検査の無い POST を足すときは必ず付ける（`validator('json', ...)` を持つ経路は hono が同じ検査をする）。
export const deliberateClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/json') {
    return c.json({ error: 'content-type: application/json が要る' as const }, 415);
  }
  await next();
});

// 部分一致で判定しない: ブラウザが単純リクエストか否かを決めるのは essence だけなので、`text/plain; note=application/json` は preflight 無しで飛ぶ。`includes('application/json')` はこれを通して穴が空く。
export function mimeEssence(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

// `isDailyReport` は `@alteroid/core` の1本を使う（写しを持たない）: 出す側は「書けなかった」の印（`unavailable`）の行も出し、数える側は数えないという違いが、判定が散ると静かに逆になる。

// `required: true` でなければ契約にならない: 省略した呼び出しに `content-type` を送る義務が無く、生成クライアントが本文もヘッダも省略して 415 に当たる。サーバの方が緩い（空でも `{}` でも通る）のは意図的。関数にしてあるのは `noBodyPostResponses` と同じ（モジュールの初期化順）。
export function noBodyPostRequestBody(description: string) {
  return {
    required: true,
    description,
    content: { 'application/json': { schema: {} } },
  };
}

// 本文を読まない POST（`{}` を送る約束の口）の `requestBody`。`consequence` は「ブラウザの単純リクエストで〜」に続く、守っている相手の言い方（「〜ないため」まで）。
export function emptyJsonPostRequestBody(consequence: string) {
  return noBodyPostRequestBody(
    '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
      '`content-type: application/json` が要る（ブラウザの単純リクエストで' +
      `${consequence}）。`,
  );
}

// 定数ではなく関数にする: `app.ts` と `openapi.ts` は互いを import するので、モジュールの初期化順によってはトップレベルで即座に評価する定数がまだ空の相手の export を読んでしまう。
export function noBodyPostResponses(): { readonly 415: JsonResponse } {
  return {
    415: errorResponse(
      'content-type が application/json ではない（ブラウザの単純リクエスト対策 — ' +
        '状態を変える POST は必ずここを通す）。',
    ),
  } as const;
}

// 複数の route の応答宣言で同じ文になる説明（`describeRoute` の `description`）。
export const NO_ACCESS_GRANT_DESCRIPTION = '許可（`access grant`）の無いアカウント。';

export const LOGGED_IN_WITHOUT_GRANT_DESCRIPTION =
  'alteroid を使う許可が無い（ログインしているが `access grant` されていない）。資格そのものが無い場合は 401。';

export const JOURNAL_FAILED_OR_REMOVE_FAILED_DESCRIPTION =
  '日誌が書けなかった（**状態を変えていない**）か、消すのに失敗した。理由の本文は返さない。';

export const INVALID_QUERY_DESCRIPTION = 'クエリが不正。';

const REMOVED_IDS_AND_COUNT_DESCRIPTION = '消した id と件数。';

const INVALID_INPUT_NOTHING_REMOVED_DESCRIPTION = '入力の形が不正（何も消していない）。';

export const UNREADABLE_IDS_MISSING_DESCRIPTION =
  '指した id のうち、読めない行に無いものがあった（何も消していない。日誌も書いていない）。';

// `describeRoute` の `responses` に並べる「application/json の応答 1 件」の写し。**状態番号のキーは含めない**: 各 route が `404: errorResponse(…)` と直に書く（`responses` の数値キーと、ハンドラの `c.json(…, 数値)` を突き合わせる試験の歯がリテラルを読む）。
// 定数ではなく関数にする理由は `noBodyPostResponses` の上の注と同じ（`resolver()` を import 時に評価しない）。
export function jsonResponse(
  description: string,
  schema: Parameters<typeof resolver>[0],
): JsonResponse {
  return { description, content: { 'application/json': { schema: resolver(schema) } } };
}

export function errorResponse(description: string): JsonResponse {
  return jsonResponse(description, errorResponseSchema);
}

export function journalWriteFailedResponse(description: string): JsonResponse {
  return jsonResponse(description, journalWriteFailedResponseSchema);
}

// 値は1文字も含めず `path` だけを見る: issue の `message` は zod の文言に入力値を埋め込むことがあり、`hook` を渡さないと `@hono/standard-validator` の既定の 400 がリクエスト本文をまるごと返すという対処が無意味になる。
export function whereValidationFailed(
  issues: readonly { readonly path?: readonly unknown[] }[],
): string {
  return issues
    .map((issue) => issue.path?.map((part) => String(part)).join('.') ?? '')
    .filter((path) => path.length > 0)
    .join(', ');
}

// 400 の本文の文: `prefix` の後ろに、形が不正な項目（`where`）があれば `: ${where}` を続ける。
export function withWhere(prefix: string, where: string): string {
  return prefix + (where === '' ? '' : `: ${where}`);
}

// 400 の本文が `{ error: prefix[: where] }` だけの経路の `onInvalid`。
export function invalidWith(prefix: string): (where: string) => { error: string } {
  return (where) => ({ error: withWhere(prefix, where) });
}

// 必須の項目を持たないが、本文が無ければ 400 で断る経路の `describeRoute` に置く（#5194）: hono-openapi 1.5 は、必須の項目を
// 持たないオブジェクトの本文に `requestBody.required` を付けない。`refine` で「どれか1つが要る」と縛った本文は spec からそれが見えず、
// 何も言わないと本文を省けると読めるため。本文が無い要求は `jsonBody` が `{}` として検査するので、全部省略可の本文には付けない（省いても通る）
export const REQUIRED_JSON_BODY = { required: true, content: {} } as const;

// HTTP の口（`app.ts` と族のファイル `app-routes-*.ts`）の中で `validator('json', ...)` を直接書かない: `hook` を渡し忘れた経路だけ `@hono/standard-validator` の既定の 400（本文そのものを返す）に落ちるので、ここへ集約して付け忘れを作れなくする。`onInvalid` を上書きしてよいのも、混ぜてよいのは `where` だけで送られてきた値は混ぜない。
export function jsonBody<Schema extends z.ZodTypeAny>(
  schema: Schema,
  onInvalid: (where: string) => Record<string, unknown> = invalidWith('入力の形が不正'),
): ReturnType<typeof validator<Schema, 'json', Env, string>> {
  return validator('json', schema, (result, c) => {
    if (result.success) return;
    return c.json(onInvalid(whereValidationFailed(result.error)), 400);
  });
}

// HTTP の口（`app.ts` と族のファイル）の中で `validator('query', ...)` を直接書かない（`jsonBody` と同じ理由）: `hook` を渡さないと既定の 400 がクエリそのものと zod の issue 配列を返す。
export function queryParams<Schema extends z.ZodTypeAny>(
  schema: Schema,
  onInvalid: (where: string) => Record<string, unknown> = invalidWith('入力の形が不正'),
): ReturnType<typeof validator<Schema, 'query', Env, string>> {
  return validator('query', schema, (result, c) => {
    if (result.success) return;
    return c.json(onInvalid(whereValidationFailed(result.error)), 400);
  });
}

export function describeActor(principal: Principal): string {
  if (principal.kind === 'operator') return '実行環境の持ち主による操作';
  // 鍵の値は書かない（id と名前だけ）。`Principal` を網羅するために持つ。
  if (principal.kind === 'integration') {
    return `連携の鍵「${principal.name}」（${principal.keyId}）による操作`;
  }
  return `許可されたアカウント（${principal.account.id}）による操作`;
}

// 落ちたら跡だけ残して握る: ここへ来る時点で状態変更は既に効いているので、`.onError` へ抜けて 500 にすると操作そのものが失敗したと誤読される（欠けるのは監査の行だけ）。pg のトランザクションで束ねる案は採らない: fs ストアでは状態変更と日誌の追記を1操作にできない。
// `detail` に本文を入れない（`noteDroppedRecord` の「本文は出さない」と同じ理由）: id や件数だけ。
// 能力を広げる口は、状態変更の後にこの関数を当てない: 日誌が落ちると記録の無い変更が生まれるので、日誌を先に書き、書けなければ状態を変えずに 500 にする。状態変更が投げたら打ち消しの行をこの関数で足す（記録が多すぎる側に倒す）。状態変更の後でないと分からない情報は2行目として best-effort で足す。
export async function appendJournalOrDrop(
  stores: Pick<Stores, 'journal'>,
  entry: JournalEntryInput,
  what: string,
  detail: string,
): Promise<JournalEntry | undefined> {
  try {
    return await stores.journal.append(entry);
  } catch (error) {
    noteDroppedRecord(what, detail, error);
    return undefined;
  }
}

export function journalWriteFailedBody(): {
  error: string;
  code: typeof JOURNAL_WRITE_FAILED_CODE;
} {
  return { error: JOURNAL_WRITE_FAILED_MESSAGE, code: JOURNAL_WRITE_FAILED_CODE };
}

// 日誌を先に書いた人間の取り消し・書き換えが、状態に届かなかったときの打ち消しの行（`removeScheduleJournalFirst` の打ち消しと同じ書式）。印（humanAction）を持たないので、クローンに「人間がした」と学ばせない。
function undoneByHumanEntry(operation: string, subject: string, why: string): JournalEntryInput {
  return {
    type: 'decision',
    decision: `直前の${operation}の行は効いていない（変えていない）。理由: ${why}`,
    grounds: `${subject}。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す`,
  };
}

// 日誌を先に書いた人間の操作が効かなかったとき、`why` を理由に打ち消しの行を積む関数（積めなければ跡だけ残す）。
export function humanRetractor(
  stores: Pick<Stores, 'journal'>,
  spec: { operation: string; subject: string; what: string; detail: string },
): (why: string) => Promise<JournalEntry | undefined> {
  return (why) =>
    appendJournalOrDrop(
      stores,
      undoneByHumanEntry(spec.operation, spec.subject, why),
      spec.what,
      spec.detail,
    );
}

// 1行を読む。`unreadable` の例外（在るが読めない行）だけ値で返し、ほかは投げ直す（`readTask` の汎用版。状態番号は呼び側が決める）
export async function readOrUnreadable<T>(
  read: () => Promise<T>,
  unreadable: new (...args: never[]) => Error,
): Promise<{ kind: 'read'; value: T } | { kind: 'unreadable'; message: string }> {
  try {
    return { kind: 'read', value: await read() };
  } catch (error) {
    if (!(error instanceof unreadable)) throw error;
    return { kind: 'unreadable', message: error.message };
  }
}

export const readJournalEntry = (stores: Pick<Stores, 'journal'>, id: string) =>
  readOrUnreadable(() => stores.journal.get(id), UnreadableJournalEntryError);

// 日誌を先に書き、書けなければ状態を変えずに投げ直す。日誌に残すのは消す id と件数だけで行の中身は書かない。指した id が読めない行に1つでも無ければ何も消さず日誌も書かずに `unknown`（指された文字列は返さない）。例外の本文は日誌にも応答にも載せない（種類 `name` だけ）。
async function removeUnreadableRowsWithJournal(params: {
  stores: Stores;
  subject: string;
  actor: string;
  route: string;
  requested: readonly string[];
  remove: (
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions,
  ) => Promise<RemoveUnreadableRowsResult>;
}): Promise<RemoveUnreadableRowsResult | { kind: 'failed' }> {
  const { stores, subject, actor, route } = params;
  // `let` ではなく入れ物にする: 閉じ込めで代入するので型の絞り込みが `never` に倒れる。
  const written: { detail?: string } = {};
  let result: RemoveUnreadableRowsResult;
  try {
    result = await params.remove(params.requested, {
      beforeRemove: async (ids) => {
        await stores.journal.append({
          type: 'decision',
          decision: `読めない${subject}の行を ${String(ids.length)} 件消そうとしている（id: ${ids.join(', ')}）`,
          grounds: `${actor}（${route}）。消すのは id で指した読めない行だけ。行の中身は書かない。`,
        });
        written.detail = `ids=${ids.join(',')}`;
      },
    });
  } catch (error) {
    const journaled = written.detail;
    if (journaled === undefined) throw error;
    await appendJournalOrDrop(
      stores,
      {
        type: 'decision',
        decision: `読めない${subject}の行を消せなかった`,
        grounds: `${actor}（${route}、状態の変更が失敗: ${kindOfError(error)}）。${journaled}`,
      },
      `読めない${subject}の行の打ち消しの日誌`,
      journaled,
    );
    noteDroppedRecord(`読めない${subject}の行の削除`, journaled, error);
    return { kind: 'failed' };
  }
  // pg は日誌をトランザクションの外で書くので、日誌と再確認のあいだに行が変わりうる: 何も消していないので「消そうとしている」の行を打ち消す。
  if (result.kind === 'unknown' && written.detail !== undefined) {
    await appendJournalOrDrop(
      stores,
      {
        type: 'decision',
        decision: `読めない${subject}の行を消さなかった`,
        grounds: `${actor}（${route}、日誌の後の再確認で ${String(result.count)} 件が読めない行に無かった。何も消していない）。${written.detail}`,
      },
      `読めない${subject}の行の打ち消しの日誌`,
      written.detail,
    );
  }
  return result;
}

// 読めない行を id で消す口（permission-grants・integration-keys・access）の 404 / 200 の本文。状態番号は route 側に残す。`noun` は「読めない○○の行」の○○、`hint` は読めない行の id を確かめる口の言い方。
function unreadableRowsMissingBody(count: number, noun: string, hint: string): { error: string } {
  return {
    error:
      `指した id のうち ${String(count)} 件が、読めない${noun}の行に無い` +
      `（何も消していない。id は ${hint}で確かめる）`,
  };
}

function unreadableRowsRemovedBody(ids: readonly string[]) {
  return unreadableRowsRemoveResponseSchema.parse({ removedIds: ids, count: ids.length });
}

// 読めない行を id で消す口（permission-grants・integration-keys・access）の `describeRoute`・本文検査・ハンドラ。口ごとの違いは説明文・消す対象の言い方・消す関数だけ。`subject` は日誌と 500 の本文の対象名、`noun` は 404 の本文の「読めない○○の行」の○○、`hint` は読めない行の id を確かめる口の言い方。
export function unreadableRowsRemoveHandlers(params: {
  stores: Stores;
  tag: string;
  summary: string;
  description: string;
  path: string;
  subject: string;
  noun: string;
  hint: string;
  extraResponses?: Record<number, ReturnType<typeof errorResponse>>;
  notFoundDescription?: string;
  remove: (
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions,
  ) => Promise<RemoveUnreadableRowsResult>;
}) {
  const { stores, subject, noun, hint } = params;
  return createFactory<{ Variables: AuthVariables }>().createHandlers(
    describeRoute({
      tags: [params.tag],
      summary: params.summary,
      description: params.description,
      responses: {
        200: jsonResponse(REMOVED_IDS_AND_COUNT_DESCRIPTION, unreadableRowsRemoveResponseSchema),
        400: errorResponse(INVALID_INPUT_NOTHING_REMOVED_DESCRIPTION),
        ...params.extraResponses,
        404: errorResponse(params.notFoundDescription ?? UNREADABLE_IDS_MISSING_DESCRIPTION),
        500: errorResponse(JOURNAL_FAILED_OR_REMOVE_FAILED_DESCRIPTION),
      },
    }),
    jsonBody(
      unreadableRowsRemoveRequestSchema,
      invalidWith('読めない行の id の入力の形が不正（何も消していない）'),
    ),
    async (c) => {
      const result = await removeUnreadableRowsWithJournal({
        stores,
        subject,
        actor: describeActor(c.get('principal')),
        route: `POST ${params.path}`,
        requested: c.req.valid('json').ids,
        remove: params.remove,
      });
      if (result.kind === 'unknown') {
        return c.json(unreadableRowsMissingBody(result.count, noun, hint), 404);
      }
      if (result.kind === 'failed') {
        return c.json({ error: `${subject}を保存できなかった` }, 500);
      }
      return c.json(unreadableRowsRemovedBody(result.ids));
    },
  );
}

// `message` を含めない: ストアのエラー文には行の中身（トークンの値）が載りうる。
export function kindOfError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// tsconfig の `lib` が ES2023 で `isWellFormed`（ES2024）が無いので最小の型だけ足す。
export function isWellFormedString(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

// 変換を core に置かない: `packages/core` は `apps/daemon` の `Principal` を知らない（層が逆）。`operator` の `auth` はそのまま運ぶ: `authenticate` で枝が確定しているので判定し直さない。
export function answerApprovalViaOf(principal: Principal): AnswerApprovalVia {
  if (principal.kind === 'integration') {
    // 連携の鍵は人間が答えた証拠にならない（`authenticate` が既定で拒否する）。
    throw new Error('連携の鍵は承認に答えられない');
  }
  return principal.kind === 'operator'
    ? { kind: 'operator', auth: principal.auth }
    : { kind: 'account', accountId: principal.account.id };
}

// `answerApprovalViaOf` をそのまま呼ばない: あれは連携の鍵で投げる。ここは連携の鍵の呼び出しを断らず、人間の操作の印だけを付けない（連携は人間ではない）。
export function humanActionOf(
  principal: Principal,
  kind: HumanActionKind,
  target: string,
): { humanAction: HumanAction } | Record<string, never> {
  if (principal.kind === 'integration') return {};
  return { humanAction: { kind, target, via: answerApprovalViaOf(principal) } };
}

// runner への配布結果を日誌の文にする（plugin・プロファイル・MCP サーバ・環境変数の全部が同じ書式）。値も `error` の本文も載せない。
export function describePluginDelivery(
  runners: readonly { readonly runnerId: string; readonly ok: boolean }[],
): string {
  const text = runners.map((r) => `${r.runnerId}=${r.ok ? 'ok' : '失敗'}`).join(', ');
  return text.length === 0 ? '配る先なし' : text;
}

// 「空」は NUL を落とした後で見る: ストアは NUL を落とすので、落とす前の長さで見ると NUL だけの値が空のまま届く。`nonBlankString`（空白だけも弾く）とは別物。
export const nonNulString = z
  .string()
  .min(1)
  .refine((value) => stripNul(value).length > 0);
