/**
 * 会話の既読を進める hook。
 *
 * **「いつ送るか」の規則は1つ**（`docs/architecture.md`「会話の既読」）: 会話の画面が表示されて
 * いて、タブが見えているとき、**画面に表示されている日誌由来の発言**の最後のものまで既読にする。
 * ここが持つのは「送るかどうか」の判定（`readTargetOf`）と、送った後の印の消し方・重複の抑止で、
 * **可視性（タブが見えているか・画面が表示されているか）の判定は呼ぶ側（画面）が持つ**——
 * 呼ぶのは見えているときだけにすること。
 *
 * **入力は `GET /conversations/:id` の応答だけである。** 受信の途中に画面へ出ている一時的な
 * 文字（transient）は日誌の発言ではなく、この応答には載らない。それで既読にしない——
 * 返答が日誌へ載って詳細を取り直したとき、はじめて対象になる。
 */
import { useCallback, useRef } from 'react';
import { useSWRConfig } from 'swr';

import { unwrap, useApi } from '../api';
import type { ConversationDetail, ConversationSummary } from '@alteroid/logic';

import { isKeyOfType } from './queries';

/** 時刻の前後。比較できない値は「後ではない」側へ倒す（送らない側。取り返しがつく）。 */
function isAfter(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && !Number.isNaN(right) && left > right;
}

/**
 * 既読にする先の発言 id。送らないときは `undefined`。
 *
 * - 対象は既定ビューで見える発言（編集で畳まれた `supersededBy` 付きを除く）の最後
 * - 最後の発言がサーバの `readThrough` より後で、かつ未読がある（`unreadCount > 0`、または
 *   最後の発言の時刻が `readThrough` より後）ときだけ
 * - `readThrough` が `null`（既読の記録を読めない）なら位置は不明なので、未読があるときだけ
 */
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

/**
 * `(conversationId, detail)` を渡すと、必要なときだけ `POST /conversations/:id/read` を送る。
 *
 * - **同じ id を重ねて送らない**（送信中・送信済みを覚える）。**失敗は黙って無視する**——
 *   覚えを外すので、次の機会（詳細の取り直し・タブが見えるようになったとき）に送り直る
 * - 送れたら、応答の位置と未読数で一覧（`conversations`）と詳細（`conversation`）の印を消す
 *   （位置はサーバの値。応答は後戻りしない位置を返すので、そのまま写してよい）
 */
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
          // 静かに無視する。次の機会に送り直す。
          sent.current.delete(mark);
        });
    },
    [api, mutate],
  );
}
