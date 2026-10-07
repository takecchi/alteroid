import { useCallback, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';

import { unwrap, useApi } from '../api';
import type { ConversationDetail, ConversationSummary } from '@alteroid/logic';

import { isKeyOfType } from './queries';

// 一覧とは別のキーにする: 一覧は日誌を遡るので重い
export const UNREAD_COUNT_KEY = { type: 'conversationUnreadCount' } as const;

export function useUnreadConversationCount() {
  const api = useApi();
  return useSWR(UNREAD_COUNT_KEY, () => api.api.GET('/conversations/unread-count').then(unwrap));
}

// 比較できない値は「後ではない」側へ倒す: 送らない側なら取り返しがつく
function isAfter(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && !Number.isNaN(right) && left > right;
}

export function readTargetOf(
  detail: Pick<ConversationDetail, 'messages' | 'readThrough' | 'unreadCount'>,
): string | undefined {
  const visible = detail.messages.filter((message) => message.supersededBy === undefined);
  const last = visible[visible.length - 1];
  if (last === undefined) return undefined;
  if (detail.readThrough === null) return detail.unreadCount > 0 ? last.id : undefined;
  if (!isAfter(last.at, detail.readThrough)) return undefined;
  return last.id;
}

export function useMarkConversationRead() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  const sent = useRef(new Set<string>());

  return useCallback(
    (conversationId: string, detail: ConversationDetail): void => {
      if (detail.conversationId !== conversationId) return;
      const through = readTargetOf(detail);
      if (through === undefined) return;
      const mark = `${conversationId}\n${through}`;
      if (sent.current.has(mark)) return;
      sent.current.add(mark);

      void api.api
        .POST('/conversations/{id}/read', {
          params: { path: { id: conversationId } },
          body: { through },
        })
        .then(unwrap)
        .then((result) => {
          void mutate(UNREAD_COUNT_KEY);
          void mutate(
            (key) => isKeyOfType(key, 'conversations'),
            (current: { conversations: ConversationSummary[] } | undefined) =>
              current === undefined
                ? current
                : {
                    ...current,
                    conversations: current.conversations.map((conversation) =>
                      conversation.conversationId === conversationId
                        ? {
                            ...conversation,
                            unreadCount: result.unreadCount,
                            readThrough: result.readThrough,
                          }
                        : conversation,
                    ),
                  },
            { revalidate: false },
          );
          void mutate(
            (key) =>
              isKeyOfType(key, 'conversation') && (key as { id?: unknown }).id === conversationId,
            (current: ConversationDetail | undefined) =>
              current === undefined
                ? current
                : { ...current, unreadCount: result.unreadCount, readThrough: result.readThrough },
            { revalidate: false },
          );
        })
        .catch(() => {
          // 失敗は黙って無視し、覚えを外す: 詳細の取り直しなど次の機会に送り直せる
          sent.current.delete(mark);
        });
    },
    [api, mutate],
  );
}
