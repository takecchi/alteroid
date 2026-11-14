import { randomUUID } from 'node:crypto';
import {
  isReservedEventSource,
  noteDroppedRecord,
  toRowsUnreadable,
  integrationKeyFingerprint,
  integrationKeyLimits,
  issueIntegrationKeyValue,
  sha256Hex,
  type IntegrationKeyRecord,
} from '@alteroid/core';
import { hasNul, EVENT_IDEMPOTENCY_KEY_MAX_LENGTH } from '@alteroid/core';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  attachmentErrorResponseSchema,
  errorResponseSchema,
  integrationKeyCreateErrorResponseSchema,
  integrationKeyCreateRequestSchema,
  integrationKeyCreateResponseSchema,
  integrationKeyResponseSchema,
  integrationKeysListResponseSchema,
  eventAcceptedResponseSchema,
  eventPostAcceptedResponseSchema,
} from './openapi.js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import {
  deliberateClient,
  noBodyPostRequestBody,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  invalidWith,
  jsonBody,
  queryParams,
  describeActor,
  appendJournalOrDrop,
  journalWriteFailedBody,
  unreadableRowsRemoveHandlers,
  kindOfError,
  isWellFormedString,
} from './app-shared.js';

const eventBody = z.object({
  source: z.string().min(1),
  payload: z.unknown().optional(),
  attachments: z.array(z.string().min(1)).optional(),
  idempotencyKey: z
    .string()
    .max(EVENT_IDEMPOTENCY_KEY_MAX_LENGTH)
    // 空白だけの目印は断る: 黙って無視して積むと、送り手は重複が畳まれていると信じたまま二重に積む
    .refine((value) => value.trim() !== '', '空白だけの目印は使えない')
    .refine((value) => !hasNul(value), 'NUL を含められない')
    .refine(isWellFormedString, '孤立サロゲートを含められない')
    .optional(),
});

// 本文まるごとが payload なので、添付の id はクエリで運ぶ。空の値は無いものとして扱う: `?attachments=` を付けていた呼び手を壊さない。
const eventSourceQuery = z.object({
  attachments: z.union([z.string(), z.array(z.string())]).optional(),
});

// 値も sha256 の全体も載せない（指紋＝先頭12桁だけ）。
function integrationKeyView(key: IntegrationKeyRecord) {
  return {
    id: key.id,
    name: key.name,
    source: key.source,
    fingerprint: integrationKeyFingerprint(key.sha256),
    createdAt: key.createdAt,
    createdBy: key.createdBy,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
    limits: integrationKeyLimits(key),
  };
}

// 名前・source・id・指紋だけ（値は書かない）。
function describeIntegrationKey(key: IntegrationKeyRecord): string {
  return `「${key.name}」（id=${key.id}、source=${key.source}、指紋=${integrationKeyFingerprint(key.sha256)}）`;
}

// ステータスの数値は各経路の `describeRoute` に直に書く: 「実際に返すステータスが宣言されているか」を測る歯が、リテラルのキーを経路ごとに読む。
function eventBadRequestResponse() {
  return {
    description:
      '本文が JSON として不正。または source が daemon 自身の予約語（`code`: `reserved_source`＝' +
      '`token-pool`・`runner-registry`。前後の空白・大文字小文字・全角を正規化した後で比べる）。' +
      'または source が NUL・孤立サロゲートを含む（`code`: `invalid_source`）。' +
      'または添付を付けられない（`code`: `attachment_missing`＝無い・期限切れ、' +
      '`attachment_conflict`＝すでに別の会話・外部イベントに結び付いている、' +
      '`attachment_forbidden`＝連携の鍵が、その鍵自身が上げていない添付を付けようとした、' +
      '`too_many`＝個数の上限超え）。いずれもイベントは投函されない。',
    content: { 'application/json': { schema: resolver(attachmentErrorResponseSchema) } },
  };
}

function eventAttachmentResponses() {
  return {
    413: jsonResponse(
      '連携の鍵の本文の上限（既定 1 MiB。連携の鍵でだけ。`POST /attachments` には掛からない）を超えた。' +
        'または添付の合計の上限超え（`code`: `total_too_large`）。',
      attachmentErrorResponseSchema,
    ),
  };
}

// 403（source の不一致）はここに置かず各経路の `describeRoute` に直に書く: 「実際に返すステータスが宣言されているか」を測る歯が、リテラルの `403` を経路ごとに読む。
// エラーには値を混ぜない（固定の文だけ）。判定は正規化の後（`isReservedEventSource`）: core は `source` だけで daemon 自身の知らせとみなす（`isDaemonSelfNotice` で受信箱の同じ知らせを1件に畳み、`token-pool` などは名指しで鍵の枠の知らせとして扱う）ので、外から名乗らせない。
const RESERVED_SOURCE_BODY = {
  error: 'この source は daemon 自身が使う予約語なので、外からは使えない（何も積んでいない）',
  code: 'reserved_source',
} as const;

// pg は NUL を落とし孤立サロゲートを U+FFFD へ置き換えて残すので別々の source が1つに潰れる: 黙って正規化せず入口で断る。予約語とは code を分ける（呼び手が「名前の問題」と「形の問題」を見分けられる）。
const INVALID_SOURCE_BODY = {
  error: 'source に NUL や孤立サロゲートは含められない（何も積んでいない）',
  code: 'invalid_source',
} as const;

function isMalformedEventSource(source: string): boolean {
  return hasNul(source) || !isWellFormedString(source);
}

const RESERVED_SOURCE_KEY_BODY = {
  error:
    'この source は daemon 自身が使う予約語なので、連携の鍵の source にできない（何も作っていない）',
  code: 'reserved_source',
} as const;

function integrationKeyEventResponses() {
  return {
    401: errorResponse('連携の鍵が無効か期限切れ（未知・失効・期限切れ）。'),
    413: errorResponse('連携の鍵の本文の上限（既定 1 MiB）を超えた。'),
    429: errorResponse(
      '連携の鍵の回数の上限（既定 60 回/分）を超えた。`Retry-After`（秒）の後でやり直す。',
    ),
  };
}

// `Retry-After` は付けない: 器の瞬断で、待ち時間の目安を持たない。
function eventNotPersistedResponse() {
  return {
    description:
      '受信箱へ永続化できなかった（器への書き込みが、拾い直しの後も失敗した）。**イベントは受け付けていない** — ' +
      '受信箱のメモリにも積んでいないので、送り直してよい（二重には届かない）。',
    content: { 'application/json': { schema: resolver(errorResponseSchema) } },
  } as const;
}

function eventNotPersistedBody() {
  return {
    error: '受信箱へ書けなかったので、イベントを受け付けていない（送り直してよい）' as const,
  };
}

export function integrationRoutes(
  ctx: AppContext,
  humanOnly: MiddlewareHandler<{ Variables: AuthVariables }>,
  noteIntegrationRefusal: (
    c: Context,
    status: 401 | 403 | 413 | 429,
    why: string,
    keyId?: string,
  ) => void,
) {
  const {
    stores,
    withEventReceiptLock,
    eventReceiptScopeOf,
    findEventReceiptQuietly,
    recordEventReceiptQuietly,
    acceptExternal,
    clock,
  } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 値（`altk_...`）も sha256 の全体も返さない（見分けるための先頭12桁だけ）。連携の鍵そのものは資格に入れない（`humanOnly` は二重の門）。
      .get(
        '/integration-keys',
        describeRoute({
          tags: ['integration-keys'],
          summary: '連携の鍵の一覧',
          description:
            '外のサービスへ渡した連携の鍵の一覧（失効・期限切れを含む）。**値も sha256 の全体も返さない**' +
            '（`fingerprint` は sha256 の先頭12桁で、見分けるためだけの値）。行が読めない（版ずれ・手編集）' +
            '鍵が在るときだけ、`rowsUnreadable`（件数と id・不正な欄名。名前などの中身は載せない）が付く。' +
            '読めない行しか無いと `keys` は空だが「鍵が無い」とは限らない（読めない行の鍵は使えない）。' +
            'id を `POST /integration-keys/unreadable/remove` に渡して消せる。',
          responses: {
            200: jsonResponse('連携の鍵の一覧。', integrationKeysListResponseSchema),
          },
        }),
        humanOnly,
        async (c) => {
          const keys = await stores.integrationKeys.listIntegrationKeys();
          const rowsUnreadable = toRowsUnreadable(
            await stores.integrationKeys.listUnreadableIntegrationKeys(),
          );
          return c.json(
            integrationKeysListResponseSchema.parse({
              keys: keys.map(integrationKeyView),
              ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
            }),
          );
        },
      )

      // `:id` と取り違えないよう別の語（`unreadable`）の下に置く。
      .post(
        '/integration-keys/unreadable/remove',
        humanOnly,
        ...unreadableRowsRemoveHandlers({
          stores,
          path: '/integration-keys/unreadable/remove',
          tag: 'integration-keys',
          summary: '読めない連携の鍵の行を、id を指して消す',
          description:
            '読めない（型に合わない形で入っている）連携の鍵の行だけを、id を指して消す。読める鍵には触れない。' +
            'id が取れない行はこの口では消せない（`auth/integration-keys.json` を手で直す）。1つでも読めない行に' +
            '無い id があれば何も消さない。消した id と件数を日誌に残す（行の中身は残さない）。',
          subject: '連携の鍵',
          noun: '連携の鍵',
          hint: '`GET /integration-keys` の `rowsUnreadable.rows[].id`（alteroid integration list）',
          remove: (ids, options) =>
            stores.integrationKeys.removeUnreadableIntegrationKeys(ids, options),
        }),
      )

      // 日誌を先に書き、書けなければ状態を変えずに 500: 能力を広げる口は記録の無い変更を作らない。日誌に鍵の値は書かない。
      .post(
        '/integration-keys',
        describeRoute({
          tags: ['integration-keys'],
          summary: '連携の鍵を発行する',
          description:
            '外のサービスへ渡す鍵を発行する。**鍵の種類そのものが「固定の 1 source で外部イベントを送る」' +
            'という 1 つの能力だけを表す**（選べる許可の一覧は無い）。通れるのは `POST /events`（本文の ' +
            'source が鍵の source と一致するとき）と `POST /events/:source`（パスが一致するとき）、MCP の報告 `POST /mcp`（道具は `report_problem` の1本。source は鍵の source に固定）、' +
            '自分の添付を上げる `POST /attachments` だけで、' +
            'それ以外の口は **すべて 403**（鍵の管理の口を含む）。本文は既定で 1 MiB、回数は既定で 60 回/分' +
            'まで（鍵ごとに上書きできる。この上限は連携の鍵にだけ掛かる）。**値（`altk_...`）はこの応答で' +
            '1度だけ返し、後からは取り出せない**（保存は sha256 だけ）。',
          responses: {
            200: jsonResponse(
              '発行した。`value` はこの応答でだけ見える。',
              integrationKeyCreateResponseSchema,
            ),
            400: jsonResponse(
              '入力の形が不正、または source が daemon 自身の予約語（`code`: `reserved_source`＝' +
                '`token-pool`・`runner-registry`）（何も作っていない）。',
              integrationKeyCreateErrorResponseSchema,
            ),
            500: journalWriteFailedResponse('日誌が書けなかった（**状態を変えていない**）。'),
          },
        }),
        humanOnly,
        jsonBody(
          integrationKeyCreateRequestSchema,
          invalidWith('連携の鍵の入力の形が不正（何も作っていない）'),
        ),
        async (c) => {
          const input = c.req.valid('json');
          // daemon 自身が使う予約語の source の鍵は作らない: 外から名乗れる鍵になる。
          if (isReservedEventSource(input.source)) return c.json(RESERVED_SOURCE_KEY_BODY, 400);
          const at = clock();
          if (input.expiresAt !== undefined && !(Date.parse(input.expiresAt) > at.getTime())) {
            return c.json({ error: 'expiresAt が過去（何も作っていない）' as const }, 400);
          }
          const value = issueIntegrationKeyValue();
          const record: IntegrationKeyRecord = {
            id: randomUUID(),
            name: input.name,
            source: input.source,
            sha256: sha256Hex(value),
            createdAt: at.toISOString(),
            createdBy: describeActor(c.get('principal')),
            expiresAt: input.expiresAt ?? null,
            revokedAt: null,
            lastUsedAt: null,
            maxBodyBytes: input.maxBodyBytes ?? null,
            ratePerMinute: input.ratePerMinute ?? null,
          };
          try {
            await stores.journal.append({
              type: 'decision',
              decision: `連携の鍵を発行: ${describeIntegrationKey(record)}`,
              grounds:
                `${describeActor(c.get('principal'))}（POST /integration-keys）。` +
                '鍵の値は書かない（名前・source・id・指紋だけ）。',
            });
          } catch (error) {
            noteDroppedRecord(
              '連携の鍵の発行の日誌（発行していない）',
              `id=${record.id}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          try {
            await stores.integrationKeys.putIntegrationKey(record);
          } catch (error) {
            // 日誌には「発行した」が残っているので打ち消す（記録が多すぎる側に倒す）。
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `連携の鍵を発行できなかった: ${describeIntegrationKey(record)}`,
                grounds: `${describeActor(c.get('principal'))}（POST /integration-keys、保存が失敗）`,
              },
              '連携の鍵の発行の打ち消しの日誌',
              `id=${record.id}`,
            );
            throw error;
          }
          const stored = (await stores.integrationKeys.getIntegrationKey(record.id)) ?? record;
          return c.json(
            integrationKeyCreateResponseSchema.parse({ key: integrationKeyView(stored), value }),
          );
        },
      )

      // 冪等: 失効済みはそのまま 200で、先の時刻を動かさず日誌も足さない。
      .post(
        '/integration-keys/:id/revoke',
        describeRoute({
          tags: ['integration-keys'],
          summary: '連携の鍵を失効させる',
          description:
            '連携の鍵を失効させる。以後その鍵は 401 になる（発行済みの値を消さなくても即座に効く）。' +
            '失効済みの鍵への再実行は 200（先の失効の時刻を動かさない）。',
          requestBody: emptyJsonPostRequestBody('失効させられないため'),
          responses: {
            200: jsonResponse('失効した（既に失効済みでも 200）。', integrationKeyResponseSchema),
            404: errorResponse('該当する鍵が無い。'),
            409: errorResponse(
              '鍵の行が読めない形で入っている（失効できない）。`POST /integration-keys/unreadable/remove` で消す。',
            ),
            500: journalWriteFailedResponse('日誌が書けなかった（**状態を変えていない**）。'),
            ...noBodyPostResponses(),
          },
        }),
        humanOnly,
        deliberateClient,
        async (c) => {
          const id = c.req.param('id');
          const before = await stores.integrationKeys.getIntegrationKey(id);
          if (before === null) {
            // 読めない形で入っている行は「無い」ではなく 409 で言い分ける。
            const unreadable = await stores.integrationKeys.listUnreadableIntegrationKeys();
            if (unreadable.some((row) => row.id === id)) {
              return c.json(
                {
                  error:
                    `連携の鍵 ${id} は読めない形で入っている（消されたのでも、失効したのでもない）。` +
                    '失効はこの口ではできない。' +
                    '消すには `POST /integration-keys/unreadable/remove`（alteroid integration remove-unreadable <id>）を使う。',
                },
                409,
              );
            }
            return c.json({ error: 'not found' as const }, 404);
          }
          if (before.revokedAt !== null) {
            return c.json(integrationKeyResponseSchema.parse({ key: integrationKeyView(before) }));
          }
          try {
            await stores.journal.append({
              type: 'decision',
              decision: `連携の鍵を失効: ${describeIntegrationKey(before)}`,
              grounds: `${describeActor(c.get('principal'))}（POST /integration-keys/:id/revoke）`,
            });
          } catch (error) {
            noteDroppedRecord(
              '連携の鍵の失効の日誌（失効していない）',
              `id=${id}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          let result;
          try {
            result = await stores.integrationKeys.revokeIntegrationKey(id, clock().toISOString());
          } catch (error) {
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `連携の鍵を失効できなかった: ${describeIntegrationKey(before)}`,
                grounds: `${describeActor(c.get('principal'))}（POST /integration-keys/:id/revoke、状態の変更が失敗）`,
              },
              '連携の鍵の失効の打ち消しの日誌',
              `id=${id}`,
            );
            throw error;
          }
          if (result.status === 'not_found') {
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `連携の鍵を失効できなかった: ${describeIntegrationKey(before)}`,
                grounds: `${describeActor(c.get('principal'))}（POST /integration-keys/:id/revoke、対象が消えていた）`,
              },
              '連携の鍵の失効の打ち消しの日誌',
              `id=${id}`,
            );
            return c.json({ error: 'not found' as const }, 404);
          }
          return c.json(
            integrationKeyResponseSchema.parse({ key: integrationKeyView(result.key) }),
          );
        },
      )

      // 何をするかはここで決めない: 対応表を持った瞬間に自動化ジョブに戻る。
      .post(
        '/events',
        describeRoute({
          tags: ['events'],
          summary: '外部イベントをクローンへ届ける',
          description:
            '自作ツール・ショートカット・CI からクローンへ出来事を届ける。何をするかはここで' +
            '決めない（対応表を持った瞬間に自動化ジョブに戻る）。' +
            '**`attachments`（任意）— `POST /attachments` が返した id を渡すと、その添付がクローンのターンへ届く' +
            '（画像はモデルへの入力として、すべての添付は通知行として）。** 検証と結び付けは投函の前に行い、' +
            '断るときはイベントを投函しない。**連携の鍵（`altk_`）で送るときは、その鍵自身が' +
            '`POST /attachments` で上げた添付だけ**付けられる（別の鍵・アカウント・operator が上げたものは 400）。' +
            '人間・operator は `POST /chat` と同じ規則（上げた主体は問わない）。結び付いた添付は別のイベント・会話へ使い回せない。' +
            '**`idempotencyKey`（任意。1〜200字）— 送り直しを見分ける目印。** 同じ送り手（連携の鍵ごと・アカウントごと・operator）・' +
            '同じ source・同じ目印の2件目は、積まずに1件目と同じ `id` を `duplicate: true` 付きの 200 で返す。' +
            '覚えておくのは受けてから7日。2件目の本文と添付は見ない（目印が同じなら同じ出来事として扱う）。',
          responses: {
            200: jsonResponse(
              '受信箱へ**永続化できた**（器へ書けてから返す。以後は配達される）。**この応答を受けたら送り直さない**' +
                '（`idempotencyKey` を付けていなければ二重に届く）。`duplicate: true` は、同じ目印の出来事を既に受けていて、今回は積まなかったことを表す。',
              eventPostAcceptedResponseSchema,
            ),
            503: eventNotPersistedResponse(),
            403: errorResponse(
              '連携の鍵の source と、本文の source が違う（連携の鍵でだけ起きる。人間・operator は任意の source を名乗れる）。',
            ),
            400: eventBadRequestResponse(),
            ...integrationKeyEventResponses(),
            ...eventAttachmentResponses(),
          },
        }),
        jsonBody(eventBody, invalidWith('source/payload の形が不正')),
        async (c) => {
          const {
            source,
            payload,
            attachments: attachmentIds,
            idempotencyKey,
          } = c.req.valid('json');
          const principal = c.get('principal');
          // 連携の鍵は本文の source が鍵の source と一致するときだけ通す（不一致は 403。日誌には書かない）。
          if (principal.kind === 'integration' && source !== principal.source) {
            noteIntegrationRefusal(c, 403, '本文の source が鍵の source と違う', principal.keyId);
            return c.json(
              { error: '本文の source が、この連携の鍵の source と違う' as const },
              403,
            );
          }
          // 予約語は正規化の後で断る。添付の検査より前: 何も結ばず何も積まない。
          if (isMalformedEventSource(source)) return c.json(INVALID_SOURCE_BODY, 400);
          if (isReservedEventSource(source)) return c.json(RESERVED_SOURCE_BODY, 400);
          const accept = async (onPersisted?: (id: string, at: string) => Promise<void>) => {
            const accepted = await acceptExternal({
              principal,
              source,
              payload,
              attachmentIds,
              onPersisted,
            });
            if (accepted.kind === 'attach-failed') return c.json(accepted.body, accepted.status);
            if (accepted.kind === 'unavailable') return c.json(eventNotPersistedBody(), 503);
            return c.json({ ok: true as const, id: accepted.id });
          };
          if (idempotencyKey === undefined) return accept();
          const scope = eventReceiptScopeOf(principal);
          return withEventReceiptLock(JSON.stringify([scope, source, idempotencyKey]), async () => {
            // 添付を結ぶ前に見分ける: 結んでからだと、1件目が結んだ添付で2件目が `attachment_conflict` になるため
            const prior = await findEventReceiptQuietly(scope, source, idempotencyKey);
            if (prior !== null) {
              return c.json({ ok: true as const, id: prior.eventId, duplicate: true as const });
            }
            return accept((eventId, at) =>
              recordEventReceiptQuietly({ scope, source, idempotencyKey, eventId, at }),
            );
          });
        },
      )

      .post(
        '/events/:source',
        describeRoute({
          tags: ['events'],
          summary: '本文の形を選べない webhook 用の入口',
          description:
            '他人が形を決めている webhook 用。本文をそのまま payload として運ぶので、送り元を' +
            '改造できなくても届く（GitHub や CI からそのまま叩ける）。JSON として読めない本文は' +
            '文字列のまま渡す。' +
            '**添付はクエリ `?attachments=<id>&attachments=<id>` で渡す**（本文は payload まるごとなので、' +
            '`POST /events` の本文の `attachments` とは渡し方だけが違い、検証・結び付け・連携の鍵の扱いは同じ）。' +
            'クエリを付けない既存の呼び手は何も変わらない。',
          requestBody: noBodyPostRequestBody(
            '**本文まるごとが payload になる。** 送り元が形を決めているので中身は縛らない。' +
              'JSON として読めない本文は文字列のまま渡す。`content-type: application/json` は' +
              '必要（ブラウザの単純リクエストで判断材料を書き込まれないため）。サーバは空の' +
              '本文も受けて空文字列にするが、**spec としては本文を必須にしてある** — 生成' +
              'クライアントに content-type を必ず付けさせるため（運ぶものが無いなら `{}`）。',
          ),
          responses: {
            200: jsonResponse(
              '受信箱へ**永続化できた**（器へ書けてから返す。以後は配達される）。**この応答を受けたら送り直さない**（二重に届く）。',
              eventAcceptedResponseSchema,
            ),
            503: eventNotPersistedResponse(),
            403: errorResponse(
              '連携の鍵の source と、パスの source が違う（連携の鍵でだけ起きる。人間・operator は任意の source を名乗れる）。',
            ),
            400: eventBadRequestResponse(),
            ...noBodyPostResponses(),
            ...integrationKeyEventResponses(),
            ...eventAttachmentResponses(),
          },
        }),
        deliberateClient,
        queryParams(eventSourceQuery),
        async (c) => {
          const source = c.req.param('source');
          const rawAttachments = c.req.valid('query').attachments;
          const attachmentIds = (
            rawAttachments === undefined
              ? []
              : Array.isArray(rawAttachments)
                ? rawAttachments
                : [rawAttachments]
          ).filter((id) => id !== '');
          const principal = c.get('principal');
          // 門番がパスで判定済みだが、ルートの解釈とずれても通さないよう、ここでも突き合わせる（二重の門）。
          if (principal.kind === 'integration' && source !== principal.source) {
            noteIntegrationRefusal(c, 403, 'パスの source が鍵の source と違う', principal.keyId);
            return c.json(
              { error: 'パスの source が、この連携の鍵の source と違う' as const },
              403,
            );
          }
          // 予約語は正規化の後で断る。本文も添付も読む前: 何も結ばず何も積まない。
          if (isMalformedEventSource(source)) return c.json(INVALID_SOURCE_BODY, 400);
          if (isReservedEventSource(source)) return c.json(RESERVED_SOURCE_BODY, 400);
          const raw = await c.req.text();
          let payload: unknown = raw;
          try {
            payload = raw.length > 0 ? JSON.parse(raw) : '';
          } catch {
            // JSON でなければ本文のまま渡す
          }
          const accepted = await acceptExternal({ principal, source, payload, attachmentIds });
          if (accepted.kind === 'attach-failed') return c.json(accepted.body, accepted.status);
          if (accepted.kind === 'unavailable') return c.json(eventNotPersistedBody(), 503);
          return c.json({ ok: true, id: accepted.id });
        },
      )
  );
}
