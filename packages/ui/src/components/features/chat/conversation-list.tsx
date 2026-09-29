import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button, Empty, ErrorNote, Spinner } from '../../common';

export interface ConversationListItem {
  id: string;
  /** 最初の発言の抜粋（1行。Markdown にはしない）。 */
  preview: string;
  /** 最後に動いた時刻の表示（「3 分前」など。整形は呼ぶ側）。 */
  updatedLabel: string;
  /** 人間との往復の数。 */
  messages: number;
}

/**
 * 会話1つぶんのリンクを描く口。**この層はルーターを知らない**ので、画面が
 * `<Link>` を置く（`AppSidebar` の `renderLink` と同じ形）。
 */
export type ConversationRenderLink = (
  target: { id: string | undefined; label?: string },
  slot: { className: string; children: ReactNode },
) => ReactNode;

/**
 * 会話の一覧（会話の画面の脇の面）。
 *
 * - `newConversation` —— 「新しい会話」の口（上の帯の右）。リンクにするのは画面
 * - `notes` —— 一覧の下に出す但し書き（何件遡ったか・先頭に届いていない・
 *   件数で落とした会話がある）。**切ったことは切ったと分かる形で言う**ので、
 *   画面が組み立てて渡す
 * - `inDrawer` —— 狭い画面でドロワーの中に置くとき（枠と幅はドロワーが持つ）
 */
export function ConversationList({
  items,
  activeId,
  renderLink,
  loading = false,
  error,
  notes,
  inDrawer = false,
}: {
  items: readonly ConversationListItem[] | undefined;
  activeId: string | undefined;
  renderLink: ConversationRenderLink;
  loading?: boolean;
  error?: unknown;
  notes?: readonly ReactNode[];
  inDrawer?: boolean;
}) {
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
              <Button size="sm" variant="ghost" aria-label="新しい会話" tabIndex={-1}>
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
        ) : items === undefined || items.length === 0 ? (
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
                        <p className="truncate text-xs">{item.preview}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {item.updatedLabel} · <span data-numeric>{item.messages}</span> 往復
                        </p>
                      </>
                    ),
                  },
                )}
              </li>
            ))}
          </ul>
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
