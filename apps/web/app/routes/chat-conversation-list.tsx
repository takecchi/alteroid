import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ConversationList as UiConversationList } from '@alteroid/ui';
import { useConversations } from '@alteroid/swr';

import { plainPreview } from '~/lib/plain-preview';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';

const CONVERSATION_PAGE_SIZE = 30;

// 広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く: 別々に書くと、一覧に何か足したときに片方だけ増える。
export function ConversationList({
  activeId,
  onNavigate,
}: {
  activeId: string | undefined;
  // useEffect で URL の変化を見る形にしない: いま開いている会話をもう一度押すと URL が変わらず、ドロワーが覆ったまま残る
  onNavigate?: (() => void) | undefined;
}) {
  const [pages, setPages] = useState(1);
  const { data, error, isLoading, isValidating, mutate } = useConversations(
    CONVERSATION_PAGE_SIZE,
    { keepPreviousData: true, pages },
  );
  const now = useMinuteNow();
  const loadingMore = pages > 1 && isValidating;
  const moreFailing = pages > 1 && error !== undefined && !isValidating;

  const notes: ReactNode[] = [];
  // 頁を足したあとの scanned は最後の頁の窓の値でしかない: 足し合わせると窓の重なりを二重に数えるため、範囲を言う
  const pagesRead = data?.pagesRead ?? 1;
  if (data !== undefined) {
    notes.push(
      pagesRead > 1
        ? `${pagesRead} 頁ぶんを読んだ（最後の頁の窓は、人間との往復 ${data.scanned} 件を走査）`
        : `人間との往復 ${data.scanned} 件を走査`,
    );
  }
  if (data?.reachedStart === false) {
    notes.push(
      `人間との往復を ${pagesRead > 1 ? `${pagesRead} 頁ぶん` : `${data.scanned} 件`}遡ったが、先頭には届いていない。これより古いやりとりが残っている可能性がある。`,
    );
  }
  if (data?.readStateUnreadable !== undefined) {
    notes.push(
      '既読の記録が読めない。未読の太字と件数は、クローンの発言を全部未読として数えた値で、会話を開いても、記録が読めるようになるまで変わらない。',
    );
  }
  if (data !== undefined && data.hiddenByLimit > 0 && data.nextCursor === undefined) {
    notes.push(
      `…ほか ${data.hiddenByLimit} 件は省略（この窓に ${data.conversations.length + data.hiddenByLimit} 件あり、新しい順に ${data.conversations.length} 件だけ出した）。`,
    );
  }

  return (
    <UiConversationList
      items={data?.conversations.map((conversation) => ({
        id: conversation.conversationId,
        preview: plainPreview(conversation.preview),
        updatedLabel: formatRelativeAtMinute(conversation.updatedAt, now),
        messages: conversation.messages,
        messagesAtLeast: data.windowsComplete === false,
        unread: conversation.unreadCount,
      }))}
      activeId={activeId}
      loading={isLoading && data === undefined}
      error={pages > 1 && data !== undefined ? undefined : error}
      more={
        data !== undefined && (data.nextCursor !== undefined || moreFailing)
          ? {
              onClick: () => {
                if (moreFailing) void mutate();
                else setPages((current) => current + 1);
              },
              loading: loadingMore,
              ...(moreFailing ? { error } : {}),
            }
          : undefined
      }
      unavailable={data === undefined && error !== undefined}
      onRetry={() => void mutate()}
      notes={notes}
      inDrawer={onNavigate !== undefined}
      newConversationTabStop
      renderLink={(target, slot) => (
        <Link
          to={target.id === undefined ? '/chat' : `/chat/${target.id}`}
          aria-current={target.id !== undefined && target.id === activeId ? 'page' : undefined}
          onClick={onNavigate}
          className={slot.className}
        >
          {slot.children}
        </Link>
      )}
    />
  );
}
