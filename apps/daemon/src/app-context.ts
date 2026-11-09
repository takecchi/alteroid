import { randomUUID } from 'node:crypto';
import type { ChatStreamEvent, CloneHost } from '@alteroid/core';
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  createAuthProviderRegistry,
  createAuthService,
  isAccountGranted,
  reasonOf,
  managerModelsOf,
  readConversationWindow,
  startSseHeartbeat,
  type AuthService,
} from '@alteroid/core';
import {
  AttachmentRejectedError,
  isAttachmentBound,
  attachmentBodyMaxBytes,
  readAttachmentLimits,
  readIntegrationAttachmentNoticeBytes,
  type EventReceipt,
  writeStderrLine,
} from '@alteroid/core';
import { bearerOf, type AuthPlan, type AuthVariables, type Principal } from './auth.js';
import { clientMessageFingerprint } from './client-message-fingerprint.js';
import { checkAndBindAttachments, type AttachmentBatchResult } from './attachment-batch.js';
import {
  SSE_SEND_QUEUE_MAX_CHARS,
  SSE_SEND_QUEUE_MAX_ITEMS,
  SseSendQueue,
} from './sse-send-queue.js';
import { guardSseWrites } from './sse-write-deadline.js';
import { type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { streamSSE as honoStreamSSE } from 'hono/streaming';
import { createTopologyActivityTracker } from './topology-activity.js';
import { createStorageHealthTracker, createTopologyService } from './topology.js';
import type { AppDeps } from './app.js';

// `createApp` が組み立てる局所（ルートが使う定数・関数・可変状態の入れ物）。`createApp` 1 回ごとに `createAppContext(deps)` を 1 回呼ぶ。
// 可変状態（`receivedClientMessages`・`startedConversations`・`topologyActivity` ほか）は呼びごとに新しく作る（モジュールの単例にしない）。
// 環境を読む呼び（`readAttachmentLimits`・`readIntegrationAttachmentNoticeBytes`）と購読を張る副作用の順序は、元の `createApp` の先頭と同じ。

// トークンや資格そのものは入れない（識別子だけ）。
export function principalRefOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return `account:${principal.account.id}`;
}

const SSE_CREDENTIAL_LOST_MESSAGE =
  'この接続の資格が使えなくなった（ログアウト・許可の取り消し・期限切れのどれか）ので、流れを閉じる。';

const SSE_CHAT_OVERFLOW_MESSAGE =
  'この接続が読むのに追いつかず、送り待ちの出来事が上限を超えたので、流れを閉じる。' +
  'クローンのターンは続いている。張り直せば続きから見える。';

export interface ReceivedClientMessage {
  readonly conversationId: string;
  readonly fingerprint: string;
  readonly settled?: Promise<boolean>;
}

export function createAppContext(deps: AppDeps) {
  const { clone, stores } = deps;
  const sseHeartbeatMs = DEFAULT_SSE_HEARTBEAT_MS;
  const sseWriteDeadlineMs = DEFAULT_SSE_HEARTBEAT_MS * 3;
  // SSE の口はすべてここを通す: 書き出しに期限を掛け、読まない受け手の接続を畳む（#4671）。口ごとに掛けると、足した口だけ守りが漏れるため
  const streamSSE: typeof honoStreamSSE = (c, cb, onError) =>
    honoStreamSSE(
      c,
      (stream) =>
        cb(
          guardSseWrites(stream, sseWriteDeadlineMs, (what) => {
            writeStderrLine(
              `alteroidd: ${c.req.path} の SSE の書き出し（${what}）が ${String(sseWriteDeadlineMs)}ms を超えたので、` +
                'この流れを畳みます（受け手が読んでいない）\n',
            );
          }),
        ),
      onError,
    );
  const attachmentLimits = deps.attachmentLimits ?? readAttachmentLimits().limits;
  const integrationAttachmentNoticeBytes = readIntegrationAttachmentNoticeBytes().bytes;
  const attachmentBodyMax = attachmentBodyMaxBytes(attachmentLimits);
  // `hono/body-limit` を使わない: chunked の本文を上限まで溜めるので 2 GiB の枠では使えない。content-length があって超えるときだけ断り、それ以外は溜めずに流しながら数える（置き場の上限と食い違ってもここの上限は必ず効く）。
  const attachmentUploadSizeGate = createMiddleware(async (c, next) => {
    const tooLarge = () =>
      new AttachmentRejectedError('too_large', `添付は 1 つ ${attachmentBodyMax} バイトまで`);
    const raw = c.req.raw;
    if (raw.body === null) {
      await next();
      return;
    }
    const declared = raw.headers.get('content-length');
    if (declared !== null && !raw.headers.has('transfer-encoding')) {
      if (Number(declared) > attachmentBodyMax) {
        return c.json({ error: tooLarge().message, code: 'too_large' as const }, 413);
      }
      await next();
      return;
    }
    const reader = raw.body.getReader();
    let size = 0;
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        size += value.length;
        if (size > attachmentBodyMax) {
          const refusal = tooLarge();
          controller.error(refusal);
          await reader.cancel(refusal).catch(() => undefined);
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    c.req.raw = new Request(raw, { body: counted, duplex: 'half' } as RequestInit);
    await next();
  });

  // 日誌を引く側（`findReceivedClientMessage`）が耐久の本体で、こちらは受信箱へ積んでから日誌へ載るまでの窓と同時の2本の再送を塞ぐだけ（プロセスが落ちれば消える）。古いものから捨てる上限つき。
  const receivedClientMessages = new Map<string, ReceivedClientMessage>();
  const RECEIVED_CLIENT_MESSAGES_MAX = 2048;

  // 別の会話の判定が先: 会話が違えば中身を比べても意味がない。
  function rejectDuplicateClientMessage(
    c: Context<{ Variables: AuthVariables }>,
    received: ReceivedClientMessage,
    clientMessageId: string,
    request: { conversationId: string | undefined; fingerprint: string },
  ) {
    if (
      request.conversationId !== undefined &&
      request.conversationId !== received.conversationId
    ) {
      return c.json(
        {
          error: `clientMessageId ${clientMessageId} は別の会話の発言として受け取り済み` as const,
          code: 'client_message_id_conflict' as const,
        },
        409,
      );
    }
    if (request.fingerprint !== received.fingerprint) {
      return c.json(
        {
          error:
            `clientMessageId ${clientMessageId} は中身（本文・添付・supersedes）の違う発言として受け取り済み` as const,
          code: 'client_message_id_mismatch' as const,
        },
        409,
      );
    }
    return undefined;
  }
  const CLIENT_MESSAGE_LOOKUP_SCAN = 200;

  // 日誌だけで判定しない: 新しい会話の1通目は `open` で id を返した後に日誌へ載る（`clone.post` は器への書き込みを待たない）ので、直後の追送が「無い会話」として断られる。
  const startedConversations = new Set<string>();
  const STARTED_CONVERSATIONS_MAX = 2048;
  function rememberStartedConversation(conversationId: string): void {
    startedConversations.add(conversationId);
    if (startedConversations.size > STARTED_CONVERSATIONS_MAX) {
      const oldest = startedConversations.values().next();
      if (oldest.done !== true) startedConversations.delete(oldest.value);
    }
  }

  async function findReceivedClientMessage(
    clientMessageId: string,
  ): Promise<ReceivedClientMessage | undefined> {
    const remembered = receivedClientMessages.get(clientMessageId);
    if (remembered !== undefined && (await (remembered.settled ?? true))) return remembered;
    const recent = await readConversationWindow(stores.journal, {
      scan: CLIENT_MESSAGE_LOOKUP_SCAN,
    });
    for (const entry of recent) {
      if (
        entry.type === 'exchange' &&
        entry.role === 'inbound' &&
        entry.clientMessageId === clientMessageId &&
        entry.conversationId !== undefined
      ) {
        return {
          conversationId: entry.conversationId,
          // 日誌の本文は NUL を落として残してある: 指紋の側が同じ規則を通すので比べ方はずれない。
          fingerprint: clientMessageFingerprint({
            text: entry.text,
            attachmentIds: entry.attachments?.map((ref) => ref.id),
            supersedes: entry.supersedes,
          }),
        };
      }
    }
    return undefined;
  }

  // 同期で呼ぶ（`await` を挟まずに「無ければ入れる」を1歩にして、同時の2本のうち片方だけが入る）。添付の検査・結び付けより前に呼ぶ: 後だと同時の2本が両方結び付けへ進み、片方が `attachment_conflict` になる。落ちた送信の id は覚えない（直した再送を重複と読まない）。`settle(false)` は先に Map から外してから待っている側を起こす。
  function claimClientMessage(
    clientMessageId: string,
    received: Omit<ReceivedClientMessage, 'settled'>,
  ):
    | { won: true; settle: (accepted: boolean) => void }
    | { won: false; existing: ReceivedClientMessage } {
    const existing = receivedClientMessages.get(clientMessageId);
    if (existing !== undefined) return { won: false, existing };
    let resolve: (accepted: boolean) => void = () => {};
    const settled = new Promise<boolean>((done) => {
      resolve = done;
    });
    const entry: ReceivedClientMessage = { ...received, settled };
    receivedClientMessages.set(clientMessageId, entry);
    if (receivedClientMessages.size > RECEIVED_CLIENT_MESSAGES_MAX) {
      const oldest = receivedClientMessages.keys().next();
      if (oldest.done !== true) receivedClientMessages.delete(oldest.value);
    }
    return {
      won: true,
      settle: (accepted) => {
        if (!accepted && receivedClientMessages.get(clientMessageId) === entry) {
          receivedClientMessages.delete(clientMessageId);
        }
        resolve(accepted);
      },
    };
  }

  function replayReceivedMessage(
    c: Context<{ Variables: AuthVariables }>,
    conversationId: string,
    clientMessageId: string,
  ) {
    return streamSSE(c, async (stream) => {
      const pump = chatEventPump();
      const attached = clone.attach(conversationId, (event) => pump.push(event));
      if (attached.inProgress === null) pump.finish();
      await pump.serve(
        stream,
        { principal: c.get('principal'), authorization: c.req.header('authorization') },
        attached.unsubscribe,
        async () => {
          await stream.writeSSE({
            event: 'open',
            data: JSON.stringify({ conversationId, clientMessageId, duplicate: true }),
          });
          for (const event of attached.inProgress ?? []) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        },
      );
    });
  }

  // `clone.post` の前に呼び、`ok: false` ならイベントを投函しない: 添付を黙って落として本文だけ送らない。連携の鍵のときだけ「同じ鍵が上げたもの」に絞る。
  function bindEventAttachments(
    attachmentIds: readonly string[] | undefined,
    eventId: string,
    principal: Principal,
  ): Promise<AttachmentBatchResult> {
    return checkAndBindAttachments(attachmentIds, {
      store: stores.attachments,
      limits: attachmentLimits,
      bind: (ids) => stores.attachments.bindToExternalEvent(ids, eventId),
      unbind: (ids) => stores.attachments.unbind(ids, { externalEventId: eventId }),
      isBoundElsewhere: (meta) => isAttachmentBound(meta),
      conflictMessage: 'すでに別の宛先に結び付いた添付は使えない',
      onlyUploadedBy: principal.kind === 'integration' ? principalRefOf(principal) : undefined,
      serializeKey: `externalEvent:${eventId}`,
    });
  }

  // 受信箱へ書けなかったときも投げたときも結んだ添付を戻す: 戻さないと送り直し（新しい id）が `attachment_conflict` で断られ、死んだ id に結ばれた添付は掃除の対象からも外れて期限まで残る（503 は「送り直してよい」の約束）。戻すのはこの id に結んだ分だけ。
  async function postExternalPersisted(
    event: Parameters<CloneHost['postPersisted']>[0],
    refs: readonly { id: string }[],
  ): Promise<Awaited<ReturnType<CloneHost['postPersisted']>>> {
    const release = () =>
      refs.length === 0
        ? Promise.resolve()
        : stores.attachments.unbind(
            refs.map((ref) => ref.id),
            { externalEventId: event.id },
          );
    // 戻す処理の失敗を外へ投げない: 投げると 503 が 500 に化け、`postPersisted` の元の例外も unbind の例外に置き換わる。
    // 受信箱へ書けない原因と unbind が失敗する原因は同じ（ストレージの不調）ことが多く、約束が要るのはまさにその場面。
    const releaseQuietly = async () => {
      try {
        await release();
      } catch (releaseError) {
        writeStderrLine(
          `alteroidd: 外部イベント ${event.id} の添付 ${String(refs.length)} 件の結び付けを戻せなかった` +
            `（期限まで残る）: ${reasonOf(releaseError)}\n`,
        );
      }
    };
    let outcome;
    try {
      outcome = await clone.postPersisted(event);
    } catch (error) {
      await releaseQuietly();
      throw error;
    }
    if (outcome === 'unavailable') await releaseQuietly();
    return outcome;
  }

  // 同じ重複キーの要求はこのデーモンの中で1本ずつ通す: 並んだ2本が両方「記録が無い」を見て、両方積むのを防ぐため。
  // 器（pg）の主キーは記録を1行に保つが、積んだ後の衝突では2件目の出来事を取り消せない。
  const eventReceiptLocks = new Map<string, Promise<unknown>>();
  function withEventReceiptLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = eventReceiptLocks.get(key) ?? Promise.resolve();
    const run = prior.then(fn);
    const tail = run.catch(() => undefined);
    eventReceiptLocks.set(key, tail);
    void tail.finally(() => {
      if (eventReceiptLocks.get(key) === tail) eventReceiptLocks.delete(key);
    });
    return run;
  }

  function eventReceiptScopeOf(principal: Principal): string {
    switch (principal.kind) {
      case 'integration':
        return `integration:${principal.keyId}`;
      case 'account':
        return `account:${principal.account.id}`;
      case 'operator':
        return 'operator';
    }
  }

  // 記録が読めない・書けないときは積む側へ倒す: 重複キーは送り直しを畳むためのもので、読めないからと断ると出来事そのものを落とすため。
  async function findEventReceiptQuietly(
    scope: string,
    source: string,
    idempotencyKey: string,
  ): Promise<EventReceipt | null> {
    try {
      return await stores.eventReceipts.findEventReceipt(
        scope,
        source,
        idempotencyKey,
        new Date().toISOString(),
      );
    } catch (error) {
      writeStderrLine(
        `alteroidd: 外部イベントの重複キーの記録が読めない（重複かどうか確かめずに積む）: ${reasonOf(error)}\n`,
      );
      return null;
    }
  }

  async function recordEventReceiptQuietly(receipt: EventReceipt): Promise<void> {
    try {
      await stores.eventReceipts.recordEventReceipt(receipt);
    } catch (error) {
      writeStderrLine(
        `alteroidd: 外部イベント ${receipt.eventId} の重複キーを記録できなかった（同じキーの送り直しは二重に積まれうる）: ${reasonOf(error)}\n`,
      );
    }
  }

  // 購読はデーモンが起きている間ずっと続くので解除しない。
  const topologyActivity = createTopologyActivityTracker();
  if (deps.journalEvents !== undefined) topologyActivity.attach(deps.journalEvents.subscribe);
  if (deps.workerToolEvents !== undefined) {
    topologyActivity.attachWorkerTools(deps.workerToolEvents.subscribe);
  }
  // `POST /events` と `POST /events/:source` の受け付けの本体（結び付け → 永続化 → 受け付けた印）。値を返すだけで、状態番号は route が決める。
  async function acceptExternal(spec: {
    principal: Principal;
    source: string;
    payload: unknown;
    attachmentIds: readonly string[] | undefined;
    onPersisted?: (id: string, at: string) => Promise<void>;
  }) {
    const { principal, source } = spec;
    const id = randomUUID();
    const attached = await bindEventAttachments(spec.attachmentIds, id, principal);
    if (!attached.ok) {
      return { kind: 'attach-failed' as const, body: attached.body, status: attached.status };
    }
    const at = new Date().toISOString();
    // 受信箱へ永続化できたときだけ 200 を返す: 書けなかったら 503 で、受信箱のメモリにも積まない。
    const outcome = await postExternalPersisted(
      {
        type: 'external',
        id,
        at,
        source,
        payload: spec.payload,
        ...(principal.kind === 'integration'
          ? { via: { keyId: principal.keyId, name: principal.name } }
          : {}),
        ...(attached.refs.length === 0 ? {} : { attachments: attached.refs }),
      },
      attached.refs,
    );
    if (outcome === 'unavailable') return { kind: 'unavailable' as const };
    await spec.onPersisted?.(id, at);
    // 日誌の external_event は使わない: クローンが取り出した時刻なので、受け付けた時刻で光らせる。
    if (principal.kind === 'integration') {
      topologyActivity.recordExternal({
        keyId: principal.keyId,
        name: principal.name,
        source,
        at,
      });
    }
    return { kind: 'accepted' as const, id };
  }

  const topologyStorage = createStorageHealthTracker({
    label:
      deps.storage === undefined
        ? undefined
        : deps.storage.startsWith('PostgreSQL')
          ? 'postgres'
          : 'fs',
    probe: deps.storageProbe,
    now: Date.now,
  });
  topologyStorage.current();
  const topology = createTopologyService({
    clone,
    ...(deps.runners === undefined ? {} : { runners: deps.runners }),
    unreadableJobs: () => stores.jobs.listUnreadableJobs(),
    activity: topologyActivity,
    storage: topologyStorage,
    modelsOf: (summary) => managerModelsOf(clone.managers, summary),
    ...(deps.cloneModel === undefined ? {} : { cloneModel: deps.cloneModel }),
    // ラベルだけを写す: 行は値を持つので、地図の側へ行ごと渡さない
    tokenLabels: async () =>
      new Map((await stores.tokens.list()).map((token) => [token.id, token.label] as const)),
    ...(deps.cloneTokenId === undefined ? {} : { cloneTokenId: deps.cloneTokenId }),
  });
  const topologyTickMs = 2000;
  const topologyDebounceMs = 200;

  const authPlan: AuthPlan = deps.auth?.plan ?? {
    enabled: false,
    providers: [],
    publicBaseUrl: '',
    tokenTtlDays: 30,
    description: '認証は無効（未設定）',
  };
  const clock = deps.now ?? (() => new Date());
  const authService: AuthService =
    deps.auth?.service ??
    createAuthService({
      store: stores.auth,
      providers: createAuthProviderRegistry(authPlan.providers),
      tokenTtlDays: authPlan.tokenTtlDays,
    });

  // operator の資格で張った流れは確かめ直さない: 失効させる口が無い資格。判定できない（ストアが投げた）ときは閉じる側へ倒す: 閉じてもクライアントは張り直せる。前の確かめ直しが終わっていなければ重ねない。
  function watchSseCredential(principal: Principal, authorization: string | undefined) {
    const bearer = principal.kind === 'account' ? bearerOf(authorization) : null;
    let lost = false;
    let checking = false;
    return {
      lost: () => lost,
      tick(wake: () => void): void {
        if (bearer === null || lost || checking) return;
        checking = true;
        void authService
          .authenticate(bearer)
          .then(
            (account) => {
              if (account === null || !isAccountGranted(account)) {
                lost = true;
                wake();
              }
            },
            () => {
              lost = true;
              wake();
            },
          )
          .finally(() => {
            checking = false;
          });
      },
    };
  }
  // ループを2本の口で別々に持たない: 資格が尽きたときの閉じ方や心拍の扱いが片方だけ変わる。購読は呼び出し側で済ませてからここへ来る（`try` を購読の直後から始めるため）。
  function chatEventPump() {
    const queue = new SseSendQueue<ChatStreamEvent>();
    let wake: (() => void) | null = null;
    let finished = false;
    return {
      push(event: ChatStreamEvent): void {
        queue.push(event);
        if (event.type === 'done' || event.type === 'error') finished = true;
        wake?.();
      },
      finish(): void {
        finished = true;
        wake?.();
      },
      async serve(
        stream: Parameters<typeof startSseHeartbeat>[0] & {
          writeSSE(message: { event: string; data: string }): Promise<void>;
          onAbort(listener: () => void | Promise<void>): void;
        },
        request: { principal: Principal; authorization: string | undefined },
        unsubscribe: () => void,
        beforeLoop: () => Promise<void>,
      ): Promise<void> {
        // `try` は購読の直後から始める: `clone.post` や `open` の書き込みが投げたときに購読が漏れる。
        try {
          // 人間が chat を閉じても、クローンのターンは走り続ける: ここで手放すのは購読だけ。
          stream.onAbort(() => {
            finished = true;
            wake?.();
          });

          // heartbeat は死んだ接続の掃除の契機でもあり、1拍ごとに資格も確かめ直す。
          const credential = watchSseCredential(request.principal, request.authorization);
          const stopHeartbeat = startSseHeartbeat(
            stream,
            sseHeartbeatMs,
            () => wake?.(),
            () => credential.tick(() => wake?.()),
          );

          try {
            await beforeLoop();

            for (;;) {
              if (stream.aborted || stream.closed) break;
              if (credential.lost()) {
                // 閉じる前に理由を1つ送る: 画面が「接続が切れた」と区別できるように、既存の `error` イベントの形で言う。
                await stream.writeSSE({
                  event: 'error',
                  // クライアント自身の資格が尽きた通知で、クローンの認証・利用上限ではない ⟹ `other`。
                  data: JSON.stringify({
                    type: 'error',
                    message: SSE_CREDENTIAL_LOST_MESSAGE,
                    kind: 'other',
                  }),
                });
                break;
              }
              const overflow = queue.overflow;
              if (overflow !== undefined) {
                // 溢れたら溜めた分は捨ててある。理由はコメント行で残し、終端の出来事（`done` / `error`）は送らずに閉じる（#4663 の続き）:
                // `error` を送ると画面はターンの失敗として扱うが、ターンは止めていない。終端の無いまま閉じれば、画面は張り直して続きを読む
                const summary =
                  `/chat の流れの受け手が読むのに追いつかず、送り待ちが上限を超えた` +
                  `（${String(overflow.items)} 件・${String(overflow.chars)} 字。上限 ` +
                  `${String(SSE_SEND_QUEUE_MAX_ITEMS)} 件・` +
                  `${String(SSE_SEND_QUEUE_MAX_CHARS)} 字）。` +
                  '溜めた分を捨ててこの流れを切った。クローンのターンは止めていない（#4662）。';
                void stores.journal
                  .append({ type: 'external_event', source: 'chat-stream', summary })
                  .catch((error: unknown) => {
                    writeStderrLine(
                      `alteroidd: /chat の流れを切ったことを日誌へ残せませんでした: ${reasonOf(error)}\n  ${summary}\n`,
                    );
                  });
                await stream.write(`: ${SSE_CHAT_OVERFLOW_MESSAGE}\n\n`).catch(() => undefined);
                break;
              }
              const item = queue.shift();
              if (item === undefined) {
                if (finished) break;
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = null;
                continue;
              }
              const { value: event, data } = item;
              await stream.writeSSE({ event: event.type, data });
              if (event.type === 'done' || event.type === 'error') break;
            }
          } finally {
            stopHeartbeat();
          }
        } finally {
          unsubscribe();
        }
      },
    };
  }
  const providerList = authPlan.providers.map(({ id, label, kind }) => ({ id, label, kind }));
  // 1プロバイダにつき1本だけ: 用途ごとに URL を増やすと token 交換時の `redirect_uri` 不一致が起きやすい。
  const callbackUrl = (provider: string) => `${authPlan.publicBaseUrl}/auth/${provider}/callback`;

  return {
    clone,
    stores,
    sseHeartbeatMs,
    streamSSE,
    attachmentLimits,
    integrationAttachmentNoticeBytes,
    attachmentUploadSizeGate,
    receivedClientMessages,
    rejectDuplicateClientMessage,
    startedConversations,
    rememberStartedConversation,
    findReceivedClientMessage,
    claimClientMessage,
    replayReceivedMessage,
    withEventReceiptLock,
    eventReceiptScopeOf,
    findEventReceiptQuietly,
    recordEventReceiptQuietly,
    topologyActivity,
    acceptExternal,
    topology,
    topologyTickMs,
    topologyDebounceMs,
    authPlan,
    clock,
    authService,
    watchSseCredential,
    chatEventPump,
    providerList,
    callbackUrl,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
