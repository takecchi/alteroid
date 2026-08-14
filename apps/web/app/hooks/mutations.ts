/**
 * 書き込みの hooks。
 *
 * **原則、楽観更新はしない。** 書いた結果は日誌に出るので、SSE
 * （`use-journal-live.ts`）がすぐ無効化を回す。画面が先に「できたことにする」と、
 * 実際には拒否された操作が成功したように見える瞬間ができる。ここは正直さを優先する。
 *
 * **例外は自分のチャット送信（`useRecordOwnMessage`）だけ。** `POST /chat` には
 * 拒否という概念が無く、受け付ければ必ず `open` イベントで会話が返る。つまり
 * 「できたことにする」がそのまま「実際にできた」なので、成功に見せても嘘には
 * ならない。例外にした理由は速さ — 会話一覧はサーバが日誌を走査して組み立てる
 * ので、SSE の往復を待つと送信のたびに一覧の反映が目に見えて遅れる。
 */
import { useCallback } from 'react';
import { useSWRConfig } from 'swr';

import { unwrap, useApi } from '~/lib/api';
import type { ConversationSummary } from '~/lib/types';

import { isKeyOfType, KEY } from './queries';

/**
 * 自分のチャット送信を会話一覧へ即時反映する（唯一の楽観更新。理由は冒頭コメント）。
 *
 * API は叩かない — SWR キャッシュを直接書き換えるだけ。`revalidate: false` に
 * しているのは、この直後に必ず SSE 経由の無効化（`exchange(with:'human')`）が
 * 届いて正しい値に置き換わるので、ここで追加の往復を足す意味が無いから。
 *
 * 書き込む値は全部**暫定**である。`startedAt` / `updatedAt` はクライアントの
 * 時計（サーバの時計とはずれうる）、`messages` は+1の推測（サーバ側の数え方と
 * 一致する保証はない）、`preview` は下の `roughPreview` が作る仮の抜粋。どれも
 * SSE 由来の再取得が届いた瞬間に正しい値へ上書きされる。
 */
export function useRecordOwnMessage() {
  const { mutate } = useSWRConfig();
  return useCallback(
    (conversationId: string, text: string) => {
      const now = new Date().toISOString();
      const shortened = roughPreview(text);
      void mutate(
        (key) => isKeyOfType(key, 'conversations'),
        (current: { conversations: ConversationSummary[]; scanned: number } | undefined) => {
          // まだ一度も取得していないキャッシュに勝手に値を作らない。
          if (current === undefined) return current;

          const index = current.conversations.findIndex(
            (conversation) => conversation.conversationId === conversationId,
          );

          if (index === -1) {
            const inserted: ConversationSummary = {
              conversationId,
              startedAt: now,
              updatedAt: now,
              messages: 1,
              preview: shortened,
            };
            // `scanned`（日誌をどこまで遡ったか）はここでは動いていないので触らない。
            // 先頭へ足すだけで末尾は切らない。次の再取得で正しい件数に戻る。
            return { ...current, conversations: [inserted, ...current.conversations] };
          }

          const existing = current.conversations[index];
          if (existing === undefined) return current;
          const updated: ConversationSummary = {
            ...existing,
            updatedAt: now,
            preview: shortened,
            messages: existing.messages + 1,
          };
          const rest = current.conversations.filter((_, i) => i !== index);
          return { ...current, conversations: [updated, ...rest] };
        },
        { revalidate: false },
      );
    },
    [mutate],
  );
}

/**
 * サーバの `preview()`（`apps/daemon/src/app.ts`）を写した。**二重管理である。**
 * サーバ側の切り方が変わったらここも手で追随しないと、反映された瞬間に抜粋の
 * 見た目が飛ぶ（見た目を飛ばさないためだけにここへ写している）。
 */
function roughPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

/** 記憶を書き換える（人間の直接編集）。 */
export function useSaveMemory() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, content: string) => {
      const result = await api.api
        .PUT('/memory/{slug}', { params: { path: { slug } }, body: { content } })
        .then(unwrap);
      await Promise.all([mutate(KEY.memory), mutate(KEY.memoryDoc(slug))]);
      return result.document;
    },
    [api, mutate],
  );
}

export function useDeleteMemory() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string) => {
      await api.api.DELETE('/memory/{slug}', { params: { path: { slug } } }).then(unwrap);
      await mutate(KEY.memory);
    },
    [api, mutate],
  );
}

/** 承認待ちに答える。 */
export function useAnswerApproval() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, answer: string) => {
      await api.api
        .POST('/approvals/{id}/answer', { params: { path: { id } }, body: { answer } })
        .then(unwrap);
      await Promise.all([mutate(KEY.approvals(true)), mutate(KEY.approvals(false))]);
    },
    [api, mutate],
  );
}

/** マネージャーへ話しかける（許可確認への `allow` / `deny` もここ）。 */
export function useSendManagerMessage() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, body: { text: string; requestId?: string; decision?: 'allow' | 'deny' }) => {
      const result = await api.api
        .POST('/managers/{id}/messages', { params: { path: { id } }, body })
        .then(unwrap);
      await Promise.all([mutate(KEY.managers), mutate(KEY.manager(id))]);
      return result;
    },
    [api, mutate],
  );
}

/**
 * マネージャーを止める。
 *
 * **本文が要る**（`DELETE` だがサーバ側に json バリデータが付いている）。理由が
 * 無くても `{}` を送る必要があり、忘れると 400 になる。
 */
export function useAbortManager() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, reason?: string) => {
      const result = await api.api
        .DELETE('/managers/{id}', {
          params: { path: { id } },
          body: reason === undefined || reason === '' ? {} : { reason },
        })
        .then(unwrap);
      await Promise.all([mutate(KEY.managers), mutate(KEY.manager(id))]);
      return result;
    },
    [api, mutate],
  );
}

/** 定期ジョブを今すぐ回す（待たずに確かめるための口）。 */
export function useRunSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (kind: string) => {
      // `body: {}` は spec が本文を必須にしているから（運ぶ情報は無い）。これがあると
      // openapi-fetch が `content-type: application/json` を自分で付けるので、
      // デーモンの門番（`deliberateClient`）を素通りできる。
      await api.api
        .POST('/schedule/{kind}/run', { params: { path: { kind } }, body: {} })
        .then(unwrap);
      await mutate(KEY.schedule);
    },
    [api, mutate],
  );
}

/** 外部イベントを流し込む（起点③を手で起こす）。 */
export function usePostEvent() {
  const api = useApi();
  return useCallback(
    async (source: string, payload: unknown) => {
      return api.api.POST('/events', { body: { source, payload } }).then(unwrap);
    },
    [api],
  );
}

/** 会話を終える。クローンがここで学びを蒸留する。 */
export function useEndConversation() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (conversationId: string) => {
      // `body: {}` の理由は `useRunSchedule` と同じ（spec が本文を必須にしている）。
      await api.api
        .POST('/chat/{conversationId}/end', { params: { path: { conversationId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.memory);
    },
    [api, mutate],
  );
}
