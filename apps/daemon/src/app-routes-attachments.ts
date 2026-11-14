import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import type { InboxEvent, Stores } from '@alteroid/core';
import {
  ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT,
  DAEMON_ATTACHMENT_USAGE_SOURCE,
  AttachmentContentRemoveError,
  AttachmentCursorError,
  AttachmentRejectedError,
  describeAttachmentAlreadyGoneRetraction,
  describeAttachmentForJournal,
  describeAttachmentRemoveFailedRetraction,
  noteDroppedRecord,
  reasonOf,
  redactErrorText,
  removeAttachmentCopy,
} from '@alteroid/core';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { principalRefOf, type AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  attachmentErrorResponseSchema,
  attachmentKeptBodySchema,
  attachmentLimitsSchema,
  attachmentListQuery,
  attachmentListResponseSchema,
  attachmentMetaSchema,
} from './openapi.js';
import {
  mimeEssence,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  jsonBody,
  queryParams,
  describeActor,
  appendJournalOrDrop,
  journalWriteFailedBody,
  kindOfError,
} from './app-shared.js';

const attachmentUploadQuery = z.object({
  keep: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional(),
  name: z.string().optional(),
  type: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;.*)?$/, 'MIME の形ではない'),
});

// 宣言された MIME は人間が決めた文字列なので、ヘッダに入れて壊れない形でなければ `application/octet-stream` に倒す。
const SAFE_MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// `application/octet-stream` だけを受ける（`deliberateClient` と同じ考え方）: CORS の単純リクエストの content-type に入らず preflight が必ず要るので、任意のページから `no-cors` の fetch や form で添付を預けられない。`multipart` を受けないのも同じ理由。
const octetStreamClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/octet-stream') {
    return c.json({ error: 'content-type: application/octet-stream が要る' as const }, 415);
  }
  await next();
});

const GONE_OR_EXPIRED_DESCRIPTION = '無い（消えた・期限切れ）。';

/**
 * 連携の鍵1本あたりの、期限内の添付の預かりがこれを越えたら知らせる（#4005。オーナーの判断で 1GiB から始める）。
 * 既定値。実際の値は `ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES` で変えられる（`readIntegrationAttachmentNoticeBytes`）
 */
export const INTEGRATION_ATTACHMENT_NOTICE_BYTES = ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT;

/**
 * 連携の鍵が上げた添付で、その鍵の預かり（期限内）が閾値を越えたら、日誌とクローンへ1回知らせる（#4005）。
 * 断らない: 枠を置かないのがオーナーの決定で、これは決め直すための材料と契機である。
 * 状態を持たず「この1件で越えたか」だけを見る（上げる前は閾値未満・上げた後は閾値以上）: 越えるのは一度きりで、デーモンの再起動をまたいでも二度鳴らないため。
 * 掃除で下がってからもう一度越えれば、もう一度鳴る。
 */
export async function noteIntegrationAttachmentUsage(
  stores: Pick<Stores, 'attachments' | 'journal'>,
  post: (event: InboxEvent) => void,
  keyId: string,
  addedBytes: number,
  threshold: number = INTEGRATION_ATTACHMENT_NOTICE_BYTES,
): Promise<void> {
  let total: number;
  try {
    total = (await stores.attachments.usage()).byIntegrationKey[keyId]?.totalBytes ?? 0;
  } catch (error) {
    noteDroppedRecord('連携の鍵の添付の使用量', `keyId=${keyId}`, error);
    return;
  }
  const before = total - addedBytes;
  if (!(before < threshold && total >= threshold)) return;
  const text =
    `連携の鍵 ${keyId} が上げた添付の預かり（期限内）が ${String(total)} バイトになり、` +
    `閾値 ${String(threshold)} バイトを越えた。上げることは断っていない。` +
    '鍵ごとの内訳は GET /attachments の usage.byIntegrationKey で見られる。止めるなら、その鍵を失効させる。';
  await appendJournalOrDrop(
    stores,
    {
      type: 'decision',
      decision: text,
      grounds: `keyId=${keyId} totalBytes=${String(total)} threshold=${String(threshold)}`,
    },
    '連携の鍵の添付の閾値の知らせ',
    `keyId=${keyId}`,
  );
  post({
    type: 'external',
    id: randomUUID(),
    at: new Date().toISOString(),
    source: DAEMON_ATTACHMENT_USAGE_SOURCE,
    payload: { text, keyId, totalBytes: total },
  });
}

export function attachmentsRoutes(ctx: AppContext, deps: AppDeps) {
  const {
    clone,
    stores,
    attachmentLimits,
    integrationAttachmentNoticeBytes,
    attachmentUploadSizeGate,
    clock,
  } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      .post(
        '/attachments',
        describeRoute({
          tags: ['attachments'],
          summary: '添付を預かる（生のバイト列）',
          description:
            '本文は**生のバイト列**で、名前と MIME はクエリ（`name` / `type`）で運ぶ。' +
            '**`content-type` は `application/octet-stream` だけを受ける**（それ以外は 415）——' +
            'CORS の単純リクエストにさせず、ブラウザが必ず preflight を通すため（`deliberateClient` と同じ考え）。' +
            '認証は他の経路と同じ。本文の上限は添付1つぶんの最大値（超えたら 413）。画像（png / jpeg / webp / gif）は' +
            '宣言と中身の先頭が一致しなければ 400。宣言が画像で、幅か高さが 8000 px を超えるものも 400（`code`: `image_dimension_too_large`。' +
            '寸法が読めないものは通す。宣言が画像以外ならこの検査は掛からず、ターンでファイルとして渡る）。0バイトの本文も 400（`code`: `empty`。Web・CLI・TUI と揃えて断る）。返った `id` を `POST /chat` の `attachments` に渡すと発言へ結び付く。' +
            '結び付けないまま 1 時間たったものは掃除される。' +
            'クエリ `keep=1` を付けると、預けた時点で保存の印が付く（期限なし。未結び付けの掃除にも掛からない。' +
            '外すのは `PATCH /attachments/:id`、消すのは `DELETE /attachments/:id`）。**連携の鍵は `keep` を付けられない**（403）。' +
            '**連携の鍵（`altk_`）もこの口だけは通れる**（自分の外部イベントに付ける添付を上げるため。#3113 段3）：' +
            '`uploadedBy` は `integration:<keyId>` になり、その鍵が `POST /events`（と MCP の `report_problem`）で付けられるのは自分が上げた添付だけ。' +
            '本文の上限は鍵の `maxBodyBytes` ではなく添付の上限（上記）に従い、1 回として鍵の回数（429）に数える。' +
            '鍵は添付を読み出せない（`GET /attachments/:id` は 403）。',
          requestBody: {
            required: true,
            description: '添付の中身（生のバイト列）。',
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            200: jsonResponse('預かった。控え（中身を含まない）を返す。', attachmentMetaSchema),
            400: jsonResponse(
              'クエリが不正、または受け付けない中身（`code`: `magic_mismatch` / `image_dimension_too_large` / `media_type_missing` / `empty`＝0バイト）。',
              attachmentErrorResponseSchema,
            ),
            413: jsonResponse('大きすぎる（`code`: `too_large`）。', attachmentErrorResponseSchema),
            403: errorResponse('連携の鍵が `keep` を付けた（鍵は保存の印を付けられない）。'),
            415: errorResponse('content-type が application/octet-stream ではない。'),
          },
        }),
        octetStreamClient,
        attachmentUploadSizeGate,
        queryParams(attachmentUploadQuery),
        async (c) => {
          const { name, type, keep } = c.req.valid('query');
          const principal = c.get('principal');
          // 連携の鍵は保存の印を付けられない: 期限なしで預けられると、鍵ごとの預け量の枠が無い前提が崩れるため
          if (keep === true && principal.kind === 'integration') {
            return c.json(
              {
                error:
                  '連携の鍵は保存の印（keep）を付けられない（期限なしで預けられない）' as const,
              },
              403,
            );
          }
          // 本文は流したまま置き場へ渡す（上限は置き場が流しながら数える）。
          const raw = c.req.raw.body;
          const body: AsyncIterable<Uint8Array> =
            raw === null ? Readable.from([]) : Readable.fromWeb(raw as NodeWebReadableStream);
          try {
            const meta = await stores.attachments.putStream({
              name: name ?? '',
              mediaType: type,
              body,
              ...(keep === true ? { kept: true } : {}),
              uploadedBy: principalRefOf(c.get('principal')),
            });
            if (principal.kind === 'integration') {
              // 応答を待たせない: 知らせは上げた結果を変えず、使用量の集計の時間を鍵の呼び手へ負わせないため
              void noteIntegrationAttachmentUsage(
                stores,
                (event) => clone.post(event),
                principal.keyId,
                meta.size,
                integrationAttachmentNoticeBytes,
              );
            }
            return c.json(meta, 200);
          } catch (error) {
            if (error instanceof AttachmentRejectedError) {
              // `reasonOf` ではなく `redactErrorText`: `reasonOf` は型名と code で包むので、Web・CLI・TUI がそのまま出す理由に混ざる。伏せ字は外さない。
              return c.json(
                { error: redactErrorText(error.message, process.env), code: error.code },
                error.code === 'too_large' ? 413 : 400,
              );
            }
            throw error;
          }
        },
      )

      // `/attachments/limits` と `/attachments/:id` より前に置く: あとから足す経路で取り違えない並びを固定する（Hono は定義順に当てる）。
      .get(
        '/attachments',
        describeRoute({
          tags: ['attachments'],
          summary: '添付の一覧と使用量',
          description:
            '預かっている添付の控え（中身を含まない）を新しい順に返す。期限切れは含まない。' +
            '会話（`conversationId`）・出所（`from`: `human` / `clone` / `manager` / `integration` / `unknown`）・' +
            '保存の有無（`kept`）・名前の部分一致（`q`。大文字小文字を問わない）で絞れる。' +
            '`limit` は既定 50・上限 200。続きがあるときだけ `nextCursor` が付く（次の呼び出しの `cursor` に渡す）。' +
            '`usage` は絞り込みに関わらず、期限内の全体の使用量（合計と出所ごと）。' +
            '**保存した添付に期限は無く、全体の容量の上限も置かない**——使用量を見て、不要なものを消すのは人間とクローンの判断である。' +
            '連携の鍵は 403（鍵は上げるだけで、預かったものを見られない）。',
          responses: {
            200: jsonResponse('控えの一覧と使用量。', attachmentListResponseSchema),
            400: errorResponse('クエリが不正（`cursor` が読めない、`limit` が範囲外など）。'),
          },
        }),
        queryParams(attachmentListQuery),
        async (c) => {
          const query = c.req.valid('query');
          let page;
          try {
            page = await stores.attachments.list({
              limit: query.limit,
              ...(query.kept === undefined ? {} : { kept: query.kept }),
              ...(query.from === undefined ? {} : { from: query.from }),
              ...(query.conversationId === undefined
                ? {}
                : { conversationId: query.conversationId }),
              ...(query.q === undefined ? {} : { q: query.q }),
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            });
          } catch (error) {
            if (error instanceof AttachmentCursorError) {
              return c.json({ error: '入力の形が不正: cursor' as const }, 400);
            }
            throw error;
          }
          const usage = await stores.attachments.usage();
          return c.json(attachmentListResponseSchema.parse({ ...page, usage }));
        },
      )

      // `/attachments/:id` より前に置く: `limits` を id と取り違えない。
      .get(
        '/attachments/limits',
        describeRoute({
          tags: ['attachments'],
          summary: '添付の上限（このデーモンが実際に使っている値）',
          description:
            '環境変数（`ALTEROID_ATTACHMENT_MAX_*`）で変えた値を含む、`POST /attachments` と `POST /chat` が' +
            '実際に使っている上限を返す。CLI・TUI・Web が送る前の検査に使う（最終判定はこのデーモン）。' +
            '認証は他の経路と同じ（連携の鍵は 403）。',
          responses: {
            200: jsonResponse('上限。', attachmentLimitsSchema),
          },
        }),
        (c) => c.json(attachmentLimitsSchema.parse(attachmentLimits)),
      )

      .get(
        '/attachments/:id/meta',
        describeRoute({
          tags: ['attachments'],
          summary: '添付の控え（メタデータだけ）',
          description: '中身を読まずに、名前・MIME・大きさ・sha256・結び付き・期限を返す。',
          responses: {
            200: jsonResponse('控え。', attachmentMetaSchema),
            404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
          },
        }),
        async (c) => {
          const meta = await stores.attachments.getMeta(c.req.param('id'));
          if (meta === undefined) return c.json({ error: 'not found' as const }, 404);
          return c.json(meta);
        },
      )

      .get(
        '/attachments/:id',
        describeRoute({
          tags: ['attachments'],
          summary: '添付の中身を返す',
          description:
            '預かった中身をそのまま返す。`content-type` は控えの MIME。**`content-disposition: attachment`**' +
            '（ファイル名は RFC 5987）と **`x-content-type-options: nosniff`** を付ける——人間が上げた中身を' +
            'ブラウザがこのオリジンの文書として開かないため。',
          responses: {
            200: {
              description: '中身。',
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
          },
        }),
        async (c) => {
          const found = await stores.attachments.open(c.req.param('id'));
          if (found === undefined) return c.json({ error: 'not found' as const }, 404);
          const { meta, stream } = found;
          return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
            'content-type': SAFE_MEDIA_TYPE.test(meta.mediaType)
              ? meta.mediaType
              : 'application/octet-stream',
            'content-length': String(meta.size),
            'content-disposition': attachmentDisposition(meta.name),
            'x-content-type-options': 'nosniff',
          });
        },
      )

      .patch(
        '/attachments/:id',
        describeRoute({
          tags: ['attachments'],
          summary: '添付の保存の印を付ける・外す',
          description:
            '`kept: true` で保存の印を付ける（期限を持たなくなり、期限でも未結び付け 1 時間の掃除でも消えない）。' +
            '`kept: false` で外す（外した時刻から保持日数後が期限になる）。すでにその状態なら何も変えない。' +
            '更新後の控えを返す。連携の鍵は 403。',
          responses: {
            200: jsonResponse('更新後の控え。', attachmentMetaSchema),
            400: errorResponse('本文が不正（`kept` は真偽値）。'),
            404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
          },
        }),
        jsonBody(attachmentKeptBodySchema),
        async (c) => {
          const { kept } = c.req.valid('json');
          const meta = await stores.attachments.setKept(c.req.param('id'), kept, clock());
          if (meta === undefined) return c.json({ error: 'not found' as const }, 404);
          return c.json(meta);
        },
      )

      .delete(
        '/attachments/:id',
        describeRoute({
          tags: ['attachments'],
          summary: '添付を消す（保存したものも）',
          description:
            '預かっている中身と控えを消す。保存の印が付いていても消す。`attachment_fetch` で取り出した写しも消す。' +
            '取り消せない。連携の鍵は 403。' +
            '消す前に、控え（id・名前・種類・大きさ・sha256・出所・保存中だったか。中身は書かない）と誰が消したかを日誌（`decision`）へ残す' +
            '（クローンの `file_delete` と同じ）。日誌に書けなければ消さずに 500 を返す。' +
            '外部の置き場に預けた中身は先に消す: 消せなかったとき（置き場の障害・設定が無い）は、消さずに 503 で断り（控えも残す）、理由を返す。もう一度消すと再試行する。',
          responses: {
            204: { description: '消した（中身が消えたときだけ）。' },
            404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
            500: journalWriteFailedResponse(
              '日誌が書けなかった（**消していない**。中身も控えも残っている）。',
            ),
            503: errorResponse(
              '中身を置き場から消せなかったので、消していない（控えも残した）。本文の `error` に理由。もう一度消すと再試行する。',
            ),
          },
        }),
        async (c) => {
          const id = c.req.param('id');
          const actor = `${describeActor(c.get('principal'))}（DELETE /attachments/:id）`;
          // 消す前に控えを日誌へ書き、書けなければ消さずに 500（#5280）: 消した後では名前も大きさも sha256 も辿れない（`file_delete` と同じ順序）。
          // 控えが無い（404 になる）回は書かない: 消すものが無い
          const meta = await stores.attachments.getMeta(id);
          if (meta !== undefined) {
            try {
              await stores.journal.append({
                type: 'decision',
                decision: `添付の中身と控えを消す: ${meta.name}（id=${meta.id}）`,
                grounds: `${actor}。消す前の控え: ${describeAttachmentForJournal(meta)}`,
              });
            } catch (error) {
              noteDroppedRecord('添付の削除の日誌（消していない）', `id=${id}`, kindOfError(error));
              return c.json(journalWriteFailedBody(), 500);
            }
          }
          let removed: boolean;
          try {
            removed = await stores.attachments.remove(id);
          } catch (error) {
            if (!(error instanceof AttachmentContentRemoveError)) {
              // 「消す」の行を書いた回だけ、途中で失敗したと足す（置き場によっては途中まで消えている）。書けなくても元の例外を投げる
              if (meta !== undefined) {
                await appendJournalOrDrop(
                  stores,
                  {
                    type: 'decision',
                    ...describeAttachmentRemoveFailedRetraction(meta, reasonOf(error), actor),
                  },
                  '添付の削除の失敗の日誌',
                  `id=${id}`,
                );
              }
              throw error;
            }
            // 断ったことを日誌に残す（先に書いた「消す」の行だけでは、消したように読まれるため）。書けなくても断りは変えない。
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `添付を消せなかった（中身を置き場から消せないので、消していない。控えも残した）: ${meta === undefined ? '' : `${meta.name}、`}id=${id}`,
                grounds:
                  `${actor}。理由: ${error.reason}。` +
                  (meta === undefined ? '' : '直前の「消す」の行は実行されていない。') +
                  'もう一度消すと再試行する。',
              },
              '添付の削除の断りの日誌',
              `id=${id}`,
            );
            return c.json(
              {
                error: `中身を置き場から消せなかったので消していない（控えも残した）。理由: ${error.reason}。もう一度消すと再試行する`,
              },
              503,
            );
          }
          // 写しは本体が無かったときも消す: 本体だけ先に消えて取り残された写しを片付ける。
          if (deps.attachmentCopiesDir !== undefined) {
            await removeAttachmentCopy(deps.attachmentCopiesDir, id);
          }
          if (!removed) {
            // 控えを読んだ後に別の手で消えていた回: 先に書いた「消す」の行はこの呼びでは実行されていない
            if (meta !== undefined) {
              await appendJournalOrDrop(
                stores,
                { type: 'decision', ...describeAttachmentAlreadyGoneRetraction(meta, actor) },
                '添付の削除の打ち消しの日誌',
                `id=${id}`,
              );
            }
            return c.json({ error: 'not found' as const }, 404);
          }
          return c.body(null, 204);
        },
      )
  );
}
