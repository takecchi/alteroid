/**
 * 書き込みの hooks。
 *
 * 楽観更新はしない。**書いた結果は日誌に出る**ので、SSE（`use-journal-live.ts`）が
 * すぐ無効化を回す。画面が先に「できたことにする」と、実際には拒否された操作が
 * 成功したように見える瞬間ができる。ここは正直さを優先する。
 */
import { useCallback } from 'react';
import { useSWRConfig } from 'swr';

import { unwrap, useApi } from '~/lib/api';

import { KEY } from './queries';

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
