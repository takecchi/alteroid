import { randomUUID } from 'node:crypto';

import type { CloneHost, Exchange } from '@alteroid/core';
import {
  conversationBindingKey,
  chatStreamEventSchema,
  computeSupersededIds,
  reasonOf,
  readConversationWindow,
  lookupConversation,
  describeMissingConversation,
  isConversationDeleted,
  clientMessageIdSchema,
  hasNul,
  stripNul,
  writeStderrLine,
} from '@alteroid/core';
import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import { checkAndBindAttachments, type AttachmentBatchResult } from './attachment-batch.js';
import { clientMessageFingerprint } from './client-message-fingerprint.js';
import {
  cloneInterruptRequestSchema,
  cloneInterruptResponseSchema,
  cloneSessionReopenRequestSchema,
  cloneSessionReopenResponseSchema,
  clientMessageLookupResponseSchema,
  okResponseSchema,
} from './openapi.js';
import {
  deliberateClient,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  NO_ACCESS_GRANT_DESCRIPTION,
  jsonResponse,
  errorResponse,
  whereValidationFailed,
  invalidWith,
  jsonBody,
  describeActor,
  readJournalEntry,
  isWellFormedString,
} from './app-shared.js';

// `supersedes` は形（`min(1)`）だけ見る: 編集できる対象かの判定は、空文字を許すと `conversationId` と同じ穴になるのでハンドラの手書き検証が持つ。
const chatBody = z
  .object({
    text: z.string(),
    // 孤立サロゲート・NUL を含む id は入口で 400 にする: pg が書き換え・脱落させて別々の id が同じ値に潰れ、添付の再 bind が conflict になる。黙って正規化しない。
    conversationId: z
      .string()
      .min(1)
      .refine(isWellFormedString, { message: '孤立サロゲートを含む' })
      .refine((id) => !hasNul(id), { message: 'NUL を含む' })
      .optional(),
    supersedes: z.string().min(1).optional(),
    // 固定の `maxItems` を書かない: 上限は環境変数で変わるので、個数・合計の検査はハンドラが持つ。
    attachments: z.array(z.string().min(1)).optional(),
    clientMessageId: clientMessageIdSchema.optional(),
  })
  // 「空」は NUL を落とした後で見る: ストアは NUL を落として残すので、落とす前の長さで見ると NUL だけの `text` が空の発言として日誌へ入る。
  .refine((body) => stripNul(body.text).length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'text が空のときは attachments が要る',
    path: ['text'],
  });

const CHAT_POST_UNAVAILABLE_MESSAGE =
  '発言を受信箱へ書けなかったので受け取っていない（記憶の器の不調）。送り直してよい。';

export function chatRoutes(ctx: AppContext) {
  const {
    clone,
    stores,
    streamSSE,
    attachmentLimits,
    rejectDuplicateClientMessage,
    startedConversations,
    rememberStartedConversation,
    findReceivedClientMessage,
    claimClientMessage,
    replayReceivedMessage,
    chatEventPump,
  } = ctx;
  return new Hono<{ Variables: AuthVariables }>()
    .post(
      '/chat',
      describeRoute({
        tags: ['chat'],
        summary: 'クローンと話す（SSE）',
        description:
          '人間の発言をクローンの受信箱へ積み、クローンの応答を SSE で流す。' +
          '**`conversationId` を省くと新しい会話を始め、渡すとその既存の会話へ続ける**（無い会話の id なら 404。その文字列で会話は作らない）。' +
          '**⚠️ `open`（200）は「受け付けた」であって、受信箱（器）への永続化の完了ではない。** ' +
          '発言は `open` を書く前にクローンへ渡すが、器への書き込みは待たない（失敗しても応答は成功のままで、' +
          '失敗は stderr にだけ残る。書けなかった発言はこのプロセスが生きているあいだは配達されるが、' +
          '再起動・デプロイを挟むと失われる）。永続化できたときだけ成功を返す口は `POST /events`・`POST /events/:source`。' +
          '**SSE。** `event:` にイベント名（`open` / `queued` / `text` / `thinking` / `tool` / ' +
          '`ask_human` / `done` / `error`）、`data:` に対応する JSON が入る。`data:` の ' +
          '形は下記スキーマ（`open` は `{conversationId, clientMessageId?}`（重複の再送のときは `duplicate: true` も）で別枠、他は ' +
          '`chatStreamEventSchema` の各枝）。人間が chat を閉じてもクローンのターンは' +
          '走り続ける（人間の不在で止まるのは承認待ちの仕事だけ）。' +
          '**`queued` と `thinking` は別の状態である。** `queued` は受信箱に積んだ' +
          '（受理したが順番待ち。先客のターンが走っていれば、ここで数分待つことがある）、' +
          '`thinking` は入力がモデルへ渡って最初の出力を待っている。前者の後に後者が来る。' +
          '**発言が日誌に載るのも `queued` の時点である**ので、`GET /conversations` には' +
          'ターンの順番を待たずに現れる。**コメント行（`:` で始まる行）の heartbeat が' +
          '周期的に流れる。SSE の仕様上クライアントは読み捨ててよい**（無音のまま死んだ' +
          '接続を掃除するための送信でもある）。' +
          '**`supersedes` — 送信済みの人間の発言を編集する。** この会話の中の、自分の' +
          '過去の発言（`role: inbound`）の id を渡すと、その発言は既定ビュー・' +
          '`conversation_read` から畳まれ、この発言が編集後の版として応答を受ける' +
          '（編集前のターンで起きた副作用——承認待ち・記憶・マネージャー・起票した Task——は' +
          '一切取り消さない）。`conversationId` と併せて渡すこと。編集できるのは' +
          '**人間の発言だけ**（クローンの応答は指せない）。' +
          '**`clientMessageId` — 送った側が発言ごとに作る一意な id（任意。英数字・`_` `-` の1〜128字）。** ' +
          '受信箱の発言と日誌の発言に残り、`open` と `GET /conversations/:id` の `messages` で返る' +
          '（送った側が、自分の発言が履歴に現れたかを本文でなく id で確かめられる）。' +
          '**同じ値が再び届いたら二重に受けない**——何も積まず、`open`（`duplicate: true`）の後、' +
          '進行中のターンがあれば途中経過から続きを流して閉じる（`GET /chat/:conversationId/stream` と同じ）。' +
          'ただし**中身（本文・添付の id の集合・`supersedes`）が1回目と違う**なら、黙って捨てずに 409（`client_message_id_mismatch`）。' +
          '別の会話で受け取り済みの値も 409（`client_message_id_conflict`）。重複の判定は、直近の日誌（人間との往復200件）と受け取り直後の記憶で行う。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: {
              'text/event-stream': { schema: resolver(chatStreamEventSchema) },
            },
          },
          400: errorResponse(
            '`text` が空で添付も無い、または本文が JSON として不正。または `supersedes` の検証に' +
              '落ちた——`conversationId` が無いのに `supersedes` がある、指した id が' +
              '見つからない・この会話のものではない、クローンの応答（outbound）を指して' +
              'いる、既に別の編集に置き換えられている、のいずれか。' +
              '`clientMessageId` の形が不正（英数字・`_` `-` の1〜128字）のときも 400。',
          ),
          404: errorResponse(
            '`conversationId` を渡したが、その会話が無い（`code: conversation_not_found`。日誌の人間との往復を' +
              '最後まで読んで見つからなかった）。**その文字列で新しい会話は始めない**——新しい会話を始めるなら' +
              '`conversationId` を省く。略記・前方一致では受けない（一意に当たる会話が在れば、`error` に完全な id を出す）。' +
              '何も積まず、添付も結び付けない。',
          ),
          409: errorResponse(
            '`clientMessageId` が、**別の会話**の発言として既に受け取られている（`code: client_message_id_conflict`）。' +
              'または、**同じ会話**で受け取り済みだが**中身が違う**（`code: client_message_id_mismatch`。' +
              '本文・添付の id の集合・`supersedes` のどれかが1回目と違う。2回目の中身は積まず、添付も結び付けない）。' +
              '中身が同じ再送は 409 ではなく、二重に受けずに 200（下の説明）。' +
              'または、`supersedes` が指す発言が日誌に**在るが読めない**（`code` は無い。400 の「見つからない」とは別。' +
              '何も積まない）。',
          ),
        },
      }),
      jsonBody(chatBody, invalidWith('text が空（添付も無い）、または本文の形が不正')),
      async (c) => {
        const {
          text,
          conversationId: given,
          supersedes,
          attachments: attachmentIds,
          clientMessageId,
        } = c.req.valid('json');

        // 検査（`supersedes`・添付）より前に見る: 1回目で受けた編集は再送のときには既に「置き換え済み」で、検査へ進むと自分自身に 400 を返す。
        const fingerprint = clientMessageFingerprint({
          text,
          attachmentIds: attachmentIds,
          supersedes,
        });
        if (clientMessageId !== undefined) {
          const received = await findReceivedClientMessage(clientMessageId);
          if (received !== undefined) {
            return (
              rejectDuplicateClientMessage(c, received, clientMessageId, {
                conversationId: given,
                fingerprint,
              }) ?? replayReceivedMessage(c, received.conversationId, clientMessageId)
            );
          }
        }

        // 確かめずに積まない: 会話は日誌から暗黙に在るので、URL の打ち間違いや略記がそのまま新しい会話になる。重複の再送（上）より後に置く: 1回目の再送は日誌に載る前でも重複として応える。
        if (given !== undefined && !startedConversations.has(given)) {
          const lookup = await lookupConversation(stores.journal, given);
          if (!lookup.found) {
            return c.json(
              {
                error: describeMissingConversation(given, lookup),
                code: 'conversation_not_found' as const,
              },
              404,
            );
          }
        }

        const conversationId = given ?? randomUUID();
        if (given === undefined) rememberStartedConversation(conversationId);

        // `supersedes` の検証と添付の検査・結び付けより前に先取りする: 後だと同時の編集の2本目が早い確認を抜けたあと1本目が日誌へ載り「置き換え済み」の 400 になる。取れなかった側は1本目の検査が終わるのを待つ: 重複の 200 は「受け取った」と言う応えなので、1本目が検査に落ちて取り下げたなら言えず、取り直して自分で検査する。取れなかった側は添付に触れない。新しい会話の重複は、こちらが引いた `conversationId` ではなく先に取った側の会話を指す。
        let claim: { settle: (accepted: boolean) => void } | undefined;
        if (clientMessageId !== undefined) {
          for (;;) {
            const attempt = claimClientMessage(clientMessageId, { conversationId, fingerprint });
            if (attempt.won) {
              claim = attempt;
              break;
            }
            if (!(await (attempt.existing.settled ?? true))) continue;
            return (
              rejectDuplicateClientMessage(c, attempt.existing, clientMessageId, {
                conversationId: given,
                fingerprint,
              }) ?? replayReceivedMessage(c, attempt.existing.conversationId, clientMessageId)
            );
          }
        }

        // 検証に落ちた送信の id は覚えない: 先取りを取り下げてから 400 を返す。
        const failEdit = (body: { error: string }, status: 400 | 409) => {
          claim?.settle(false);
          return c.json(body, status);
        };

        // `clone.post` を呼ぶ前に弾く: 弾いたときは日誌に何も積まない。
        if (supersedes !== undefined) {
          try {
            if (given === undefined) {
              return failEdit(
                { error: 'supersedes を指定するには conversationId が要る' as const },
                400,
              );
            }
            // 対象は `journal.get` で直接引く: `scan`/窓には縛られない。
            const targetRead = await readJournalEntry(stores, supersedes);
            // 在るが読めない行を「見つからない」（400）と言わない: 他の `Unreadable*Error` と同じ 409。
            if (targetRead.kind === 'unreadable')
              return failEdit({ error: targetRead.message }, 409);
            const target = targetRead.value;
            if (
              target === null ||
              target.type !== 'exchange' ||
              target.with !== 'human' ||
              target.conversationId !== given
            ) {
              return failEdit(
                {
                  error:
                    `supersedes が指す発言 ${supersedes} は見つからないか、この会話のものではない` as const,
                },
                400,
              );
            }
            if (target.role === 'outbound') {
              return failEdit(
                { error: 'supersedes はクローンの応答ではなく人間の発言だけを指せる' as const },
                400,
              );
            }
            // 置き換え済みかは畳み込み規則（`computeSupersededIds`）でしか判定できない: 表示用の窓ではなくこの会話の全履歴が要るので `scan` に事実上の無制限を渡す。他の会話の往復は読まない（ストア側で絞る）。
            const fullHistory = await readConversationWindow(stores.journal, {
              scan: Number.MAX_SAFE_INTEGER,
              conversationId: given,
            });
            const chronological = fullHistory
              .filter(
                (entry): entry is Exchange =>
                  entry.type === 'exchange' &&
                  entry.with === 'human' &&
                  entry.conversationId === given,
              )
              .reverse();
            const supersededIds = computeSupersededIds(chronological);
            if (supersededIds.has(supersedes)) {
              return failEdit(
                {
                  error:
                    `supersedes が指す発言 ${supersedes} は既に別の編集に置き換えられている` as const,
                },
                400,
              );
            }
          } catch (error) {
            claim?.settle(false);
            throw error;
          }
        }

        // 弾いたら（例外も）先取りを取り下げる: 検査で落ちた送信の id は覚えない。
        let attached: AttachmentBatchResult;
        try {
          attached = await checkAndBindAttachments(attachmentIds, {
            store: stores.attachments,
            limits: attachmentLimits,
            bind: (ids) => stores.attachments.bind(ids, conversationId),
            unbind: (ids) => stores.attachments.unbind(ids, { conversationId }),
            isBoundElsewhere: (meta) =>
              meta.managerReportId !== undefined ||
              (meta.conversationId !== undefined && meta.conversationId !== conversationId),
            conflictMessage: '別の会話に結び付いた添付は使えない',
            serializeKey: conversationBindingKey(conversationId),
          });
        } catch (error) {
          claim?.settle(false);
          throw error;
        }
        if (!attached.ok) {
          claim?.settle(false);
          return c.json(attached.body, attached.status);
        }
        const attachmentRefs = attached.refs;
        // 新しく引いた会話 id で受信箱へ書けなかったら、結んだ添付を戻す（#4759）: 送り直しは別の新しい会話 id になり、死んだ id に結ばれたままだと `attachment_conflict` で断られ続けるため。
        // 既存の会話では戻さない: 送り直しも同じ id に結び直すだけで困らず、戻すと同じ会話の他の発言の添付を外しうるため。
        // 受け取りの印を取り下げる前に呼ぶ: 同じ clientMessageId で待っている要求が、取り下げで起きて同じ添付を自分の会話 id へ結ぼうとするため。
        // 投げない: 戻せなかった添付は保持の期限まで残るだけで、元の失敗（503・例外）を置き換えないため（`postExternalPersisted` と同じ）
        const releaseNewConversationAttachments = async (): Promise<void> => {
          if (given !== undefined || attachmentRefs.length === 0) return;
          try {
            await stores.attachments.unbind(
              attachmentRefs.map((ref) => ref.id),
              { conversationId },
            );
          } catch (releaseError) {
            writeStderrLine(
              `alteroidd: 新しい会話 ${conversationId} の添付 ${String(attachmentRefs.length)} 件の結び付けを戻せなかった` +
                `（期限まで残る）: ${reasonOf(releaseError)}\n`,
            );
          }
        };
        // 受け取りの印（`claim`）は、受信箱へ書けた後で確定させる（#4679）: 書けなかった発言の id を「受け取り済み」と覚えると、再送が重複として畳まれるため

        return streamSSE(c, async (stream) => {
          const pump = chatEventPump();
          const unsubscribe = clone.subscribe(conversationId, (event) => pump.push(event));

          await pump.serve(
            stream,
            { principal: c.get('principal'), authorization: c.req.header('authorization') },
            unsubscribe,
            async () => {
              // `open` を書く前に積む（順序に意味がある）: `open` は「投函はもう済んだ」の合図で、追送だけしたい呼び（Web UI）は `open` を見た時点で接続を捨てる。逆順だと `stream.onAbort` が走った後にここへ来て、積む前に抜ける経路が生まれ発言が黙って消える。購読は手前で張ってあるので `queued` も取りこぼさない。
              // 受信箱へ書けたのを待ってから `open` を返す（#4679）: 待たずに返すと、書けなかった発言は「送れた」と見えたまま再起動で消えるため。
              // 書けなかったら `open` を出さずに閉じる: 画面と CLI は「送れたか確かめられなかった」として入力を戻す。日誌の発言の行は書けたときにしか書かれない
              let outcome: Awaited<ReturnType<CloneHost['postPersisted']>>;
              try {
                outcome = await clone.postPersisted({
                  type: 'human_message',
                  id: randomUUID(),
                  at: new Date().toISOString(),
                  text,
                  conversationId,
                  ...(supersedes === undefined ? {} : { supersedes }),
                  ...(attachmentRefs.length === 0 ? {} : { attachments: attachmentRefs }),
                  ...(clientMessageId === undefined ? {} : { clientMessageId }),
                });
              } catch (error) {
                await releaseNewConversationAttachments();
                claim?.settle(false);
                throw error;
              }
              if (outcome === 'unavailable') {
                await releaseNewConversationAttachments();
                claim?.settle(false);
                await stream.write(`: ${CHAT_POST_UNAVAILABLE_MESSAGE}\n\n`).catch(() => undefined);
                pump.finish();
                return;
              }
              claim?.settle(true);

              await stream.writeSSE({
                event: 'open',
                data: JSON.stringify({
                  conversationId,
                  ...(clientMessageId === undefined ? {} : { clientMessageId }),
                }),
              });
            },
          );
        });
      },
    )
    .get(
      '/client-messages/:clientMessageId',
      describeRoute({
        tags: ['chat'],
        summary: '`clientMessageId` から受け取った会話を引く',
        description:
          '`POST /chat` で受け取った発言の `clientMessageId` から、その会話の id を返す。' +
          '新しい会話の送信が `open` の前に中断され、会話 id を知らないときに、受け取られたかを確かめて会話を取り直すための口。' +
          '引き方は `POST /chat` の重複の確認と同じ（直近の日誌の人間との往復200件と、受け取り直後の記憶）。' +
          '受け取っていない（検査に落ちて取り下げられた分を含む）・遡れる範囲に無いときは 404。',
        responses: {
          200: jsonResponse('受け取り済み。その会話の id。', clientMessageLookupResponseSchema),
          400: errorResponse('`clientMessageId` の形が不正（英数字・`_` `-` の1〜128字）。'),
          404: errorResponse('受け取っていない。'),
        },
      }),
      async (c) => {
        const parsed = clientMessageIdSchema.safeParse(c.req.param('clientMessageId'));
        if (!parsed.success) {
          return c.json({ error: 'clientMessageId は英数字・_ - の1〜128字' as const }, 400);
        }
        const received = await findReceivedClientMessage(parsed.data);
        if (received === undefined) {
          return c.json({ error: '受け取っていない clientMessageId' as const }, 404);
        }
        return c.json({ conversationId: received.conversationId });
      },
    )

    .get(
      '/chat/:conversationId/stream',
      describeRoute({
        tags: ['chat'],
        summary: '進行中のターンの途中経過に戻る（SSE）',
        description:
          '発言を投函せずに、会話の購読だけを張る。**SSE。** 最初に `open`（' +
          '`{conversationId, inProgress, pending}`）を流す。`pending` は、その会話でいま答えを待っている' +
          '発言（`POST /chat` の `clientMessageId` を持つものだけ）の `[{clientMessageId, state}]`。' +
          '`state` は `running`（ターンが走っている）・`starting`（取り出し済みでターンはまだ）・' +
          '`held`（利用上限の枠で保持）・`queued`（受信箱で順番待ち）。並びは `running` / `starting`、' +
          '`held`、`queued`（古い順）。まとめ読みされた発言は、そのターンの分がすべて同じ state で載る。' +
          '誰が打った発言かは区別しない。無ければ `[]`。`inProgress` が true なら、そのターンで' +
          'いままでに出た分（`queued` / `thinking` / `tool` / `text` / `ask_human` / ' +
          '`usage_limited` / `attachments`（クローンが返信に添えた添付の控え。中身は ' +
          '`GET /attachments/:id`）。隣り合う `text` は1つにまとめてある）を先に流し、続きを流して、' +
          '`done` / `error` で閉じる。false なら `open` だけで閉じる（進行中のターンが' +
          '無い。会話の中身は `GET /conversations/:id` が持つ）。' +
          '**いままでの分と続きの継ぎ目で、取りこぼしも二重渡しも起きない。** ' +
          '`POST /chat` と同じく、**コメント行（`:` で始まる行）の heartbeat が周期的に' +
          '流れる**ほか、開いている間も資格を確かめ直す（失効したら `error` を1つ流して' +
          '閉じる）。人間がこの口を閉じてもターンは走り続ける。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: {
              'text/event-stream': { schema: resolver(chatStreamEventSchema) },
            },
          },
          404: errorResponse(
            'この会話は削除されている（`code: conversation_deleted`。#4218）。走り続けているターンの途中経過も見せない。',
          ),
          503: errorResponse('この器は途中経過を持たない（能力を落とさず、黙って隠さない）。'),
        },
      }),
      async (c) => {
        const attach = clone.attach.bind(clone);
        const conversationId = c.req.param('conversationId');
        if (await isConversationDeleted(stores.journal, conversationId)) {
          return c.json(
            { error: 'この会話は削除されている' as const, code: 'conversation_deleted' as const },
            404,
          );
        }

        return streamSSE(c, async (stream) => {
          const pump = chatEventPump();
          // `await` を挟む前に呼ぶ: 写しを取ることと購読を張ることは `attach` の中で同じ同期区間に入り、挟むと継ぎ目に出来事が割り込む。
          const { inProgress, pending, unsubscribe } = attach(conversationId, (event) =>
            pump.push(event),
          );
          if (inProgress === null) pump.finish();

          await pump.serve(
            stream,
            { principal: c.get('principal'), authorization: c.req.header('authorization') },
            unsubscribe,
            async () => {
              await stream.writeSSE({
                event: 'open',
                data: JSON.stringify({ conversationId, inProgress: inProgress !== null, pending }),
              });
              // いままでの分を先、続き（`pump` の列）を後に流す: `pump` の列には `attach` より後の出来事だけが入るので、順序も重複も崩れない。
              for (const event of inProgress ?? []) {
                await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
              }
            },
          );
        });
      },
    )

    .post(
      '/chat/:conversationId/end',
      describeRoute({
        tags: ['chat'],
        summary: '会話の終了（蒸留の契機）',
        description:
          '会話の終了 = 蒸留の契機。CLI が chat を抜けるときに叩く。運ぶ情報は無い（`{}` を送る）。',
        requestBody: emptyJsonPostRequestBody('蒸留ターンを起こされないため'),
        responses: {
          200: jsonResponse('蒸留を促した。', okResponseSchema),
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        await clone.endConversation(c.req.param('conversationId'));
        return c.json({ ok: true });
      },
    )

    .post(
      '/clone/interrupt',
      describeRoute({
        tags: ['chat'],
        summary: 'いま走っているクローンのターンを止める',
        description:
          'セッションと受信箱はそのまま残る（次の合図で次のターンが始まる）。' +
          '走っているターンが無ければ outcome: idle。止めたことは日誌に [判断] の1行で残る。' +
          '**対象（`conversationId` と `clientMessageId`）を渡すと、その発言のターンしか止めない（#3956）。** ' +
          'その発言のターンが走っていれば `interrupted`。まだ順番待ちなら受信箱の行ごと取り下げて配らず ' +
          '`withdrawn`（発言の日誌の行は残り、取り下げたことが [判断] の1行で足される）。' +
          '走っているのが別の起点のターンなら止めず `not_target`。発言は取り出し済みでターンがまだ始まって' +
          'いなければ `starting`（もう一度呼べば止まる）。答え終わっていれば `idle`。' +
          '対象を省く（`{}`）と、種類を問わず走っているターンを止める（従来どおり）。',
        requestBody: {
          required: true,
          description:
            '`{}` または `{ conversationId, clientMessageId }`（片方だけは 400）。' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストでターンを止められないため）。',
          content: { 'application/json': { schema: resolver(cloneInterruptRequestSchema) } },
        },
        responses: {
          200: jsonResponse(
            '止めた・取り下げた・別のターンなので止めなかった・止めるものが無かった・この器では止められない、のどれか。',
            cloneInterruptResponseSchema,
          ),
          400: errorResponse('本文が JSON として不正。または対象が片方しか無い・形が不正。'),
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        // 壊れた JSON を対象なしとは読まない: 別の仕事を止めてしまう。
        const rawText = await c.req.text();
        let raw: unknown = {};
        if (rawText.trim() !== '') {
          try {
            raw = JSON.parse(rawText);
          } catch {
            return c.json({ error: '本文が JSON として不正' as const }, 400);
          }
        }
        const parsed = cloneInterruptRequestSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json(
            { error: `入力の形が不正: ${whereValidationFailed(parsed.error.issues)}` },
            400,
          );
        }
        const { conversationId, clientMessageId } = parsed.data;
        if ((conversationId === undefined) !== (clientMessageId === undefined)) {
          return c.json(
            { error: 'conversationId と clientMessageId は2つとも渡すか、2つとも省く' as const },
            400,
          );
        }
        const outcome =
          conversationId === undefined || clientMessageId === undefined
            ? await clone.interruptTurn()
            : await clone.interruptTurn({ conversationId, clientMessageId });
        return c.json(cloneInterruptResponseSchema.parse({ outcome }));
      },
    )

    .post(
      '/clone/session/reopen',
      describeRoute({
        tags: ['chat'],
        summary: 'クローンのセッションを resume せずに開き直す',
        description:
          'クローンの SDK セッションを、resume せず新しく開き直す。**生ログは消さない**' +
          '（古いセッションの生ログはアーカイブへ退避され、会話の記録も残る）。' +
          '**走っているターンは最後まで走り**（outcome: deferred。ターンの境界で開き直す）、' +
          'セッションが無ければ outcome: now（次に開くセッションから resume しない）。' +
          '**`distill` の既定は false**——安全分類器に弾かれているセッションの末尾を記憶の蒸留へ送ると、' +
          '送った先でまた弾かれて墓標が立ち、起動のたびに同じ末尾を送り直す。通れば汚れた内容を記憶へ' +
          '書き込む。蒸留したいときだけ `distill: true` を渡す。' +
          '**マネージャーは止めない**（その報告は新しいセッションへ届く。`runningManagers` は走っている数で、' +
          '取れなかったときは欄が無い）。新しいセッションの最初のターンに、開き直したこと・理由・古い' +
          'session id・退避した archive id（`GET /archive/:id` で読める）がクローンへ1度だけ伝わる。' +
          '受けたことと開き直したことは日誌に [判断] の行で残る。',
        requestBody: {
          required: true,
          description:
            '`{ confirm: true, distill?, reason? }`。`confirm: true` が無ければ 400。' +
            '`reason` は 1〜500 字（省略時は「人間の操作」）。',
          content: { 'application/json': { schema: resolver(cloneSessionReopenRequestSchema) } },
        },
        responses: {
          200: jsonResponse(
            '開き直す印を立てた（now / deferred）。この器では開き直せないなら unsupported。',
            cloneSessionReopenResponseSchema,
          ),
          400: errorResponse('`confirm: true` を伴っていない、または形が不正。'),
          403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
        },
      }),
      jsonBody(
        cloneSessionReopenRequestSchema,
        invalidWith(
          '`confirm: true` を伴っていないか、形が不正（セッションの開き直しは確認を必須にしてある。' +
            'reason は 1〜500 字）',
        ),
      ),
      async (c) => {
        const body = c.req.valid('json');
        const result = await clone.reopenSession({
          reason: body.reason ?? '人間の操作',
          distill: body.distill ?? false,
          actor: describeActor(c.get('principal')),
        });
        return c.json(cloneSessionReopenResponseSchema.parse(result));
      },
    );
}
