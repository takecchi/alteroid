import { BellDot, Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Button, Empty, ErrorNote, Spinner } from '../../common';

export interface ConversationListItem {
  id: string;
  preview: string;
  updatedLabel: string;
  messages: number;
  messagesAtLeast?: boolean;
  unread?: number;
}

// リンクを描く口を受ける: この層はルーターを知らないため
export type ConversationRenderLink = (
  target: { id: string | undefined; label?: string },
  slot: { className: string; children: ReactNode },
) => ReactNode;

export interface ConversationListMore {
  onClick: () => void;
  loading?: boolean;
  error?: unknown;
}

// `unavailable` のとき「まだ会話がない。」を出さない: 読めていないのに会話が無いように読めるため
// 「新しい会話」のボタンを既定で Tab の順路から外す: リンクの中のボタンなので、Tab が同じ行き先に2回止まるため
export function ConversationList({
  items,
  activeId,
  renderLink,
  loading = false,
  error,
  unavailable = false,
  notes,
  inDrawer = false,
  newConversationTabStop = false,
  more,
}: {
  items: readonly ConversationListItem[] | undefined;
  activeId: string | undefined;
  renderLink: ConversationRenderLink;
  loading?: boolean;
  error?: unknown;
  unavailable?: boolean;
  notes?: readonly ReactNode[];
  inDrawer?: boolean;
  newConversationTabStop?: boolean;
  more?: ConversationListMore;
}) {
  const display = useDisplayText();
  return (
    <aside
      className={cn(
        'flex flex-col bg-card',
        inDrawer ? 'min-h-0 flex-1' : 'w-64 shrink-0 border-r border-border',
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="text-sm font-semibold">会話</span>
        {renderLink(
          { id: undefined, label: '新しい会話' },
          {
            className: '',
            children: (
              <Button
                size="sm"
                variant="ghost"
                aria-label="新しい会話"
                tabIndex={newConversationTabStop ? undefined : -1}
              >
                <Plus className="size-4" aria-hidden />
              </Button>
            ),
          },
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorNote error={error} className="m-3" />
        {loading ? (
          <Spinner />
        ) : unavailable ? null : items === undefined || items.length === 0 ? (
          <Empty>まだ会話がない。</Empty>
        ) : (
          <ul aria-label="会話">
            {items.map((item) => (
              <li key={item.id}>
                {renderLink(
                  { id: item.id },
                  {
                    className: cn(
                      'block border-b border-border px-3 py-2 transition-colors hover:bg-muted',
                      item.id === activeId && 'lumen-edge bg-accent text-accent-foreground',
                    ),
                    children: (
                      <>
                        <div className="flex items-center gap-2">
                          <p
                            className={cn(
                              'min-w-0 flex-1 truncate text-xs',
                              unreadOf(item) > 0 && 'font-semibold',
                            )}
                          >
                            {item.preview}
                          </p>
                          {unreadOf(item) > 0 && <UnreadMark count={unreadOf(item)} />}
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {item.updatedLabel} · 発言 <span data-numeric>{item.messages}</span> 件
                          {item.messagesAtLeast === true ? '以上' : ''}
                        </p>
                      </>
                    ),
                  },
                )}
              </li>
            ))}
          </ul>
        )}
        {more !== undefined && (
          <div className="px-3 py-2">
            {more.error !== undefined && more.error !== null && (
              <p role="alert" className="mb-1 text-[11px] break-words text-destructive">
                続きを読めなかった（
                {display.error(
                  more.error instanceof Error ? more.error.message : String(more.error),
                )}
                ）。もう一度押せば取り直す。
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              disabled={more.loading === true}
              onClick={more.onClick}
            >
              {more.loading === true ? '読み込み中…' : 'もっと見る'}
            </Button>
          </div>
        )}
      </div>

      {notes?.map((note, index) => (
        <p
          key={index}
          className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground"
        >
          {note}
        </p>
      ))}
    </aside>
  );
}

function unreadOf(item: ConversationListItem): number {
  return item.unread ?? 0;
}

function UnreadMark({ count }: { count: number }) {
  return (
    <>
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
      >
        <BellDot className="size-3" aria-hidden />
        <span data-numeric>{count}</span>
      </span>
      <span className="sr-only">未読 {count} 件</span>
    </>
  );
}
