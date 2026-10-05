import { BellDot, Plus } from 'lucide-react';
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
  /** 未読の数（クローン側の発言のうち、まだ読んでいないもの）。省略・0 は未読なし。 */
  unread?: number;
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
 * - `unavailable` —— 取得に失敗して1件も読めていないとき（#2323）。「まだ会話がない。」を
 *   出さない（読めていないのに会話が無いように読める）。失敗は `error` の `ErrorNote` が
 *   言う。再検証の失敗で一覧が残っているときは立てない（一覧をそのまま出す）。
 *   **`items` が未取得なだけ（失敗していない）なら、従来どおり「まだ会話がない。」**
 * - `notes` —— 一覧の下に出す但し書き（何件遡ったか・先頭に届いていない・
 *   件数で落とした会話がある）。**切ったことは切ったと分かる形で言う**ので、
 *   画面が組み立てて渡す
 * - `inDrawer` —— 狭い画面でドロワーの中に置くとき（枠と幅はドロワーが持つ）
 * - `newConversationTabStop` —— 「新しい会話」のボタンを Tab の順路に残すか。既定は
 *   外す（リンクの中のボタンなので、Tab が同じ行き先に2回止まる）。真なら残す
 */
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
}) {
  return (
    <aside
      className={cn(
        'flex flex-col bg-card',
        // ドロワーの中では枠と幅は Drawer 側が持っている。
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
                        {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
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

function unreadOf(item: ConversationListItem): number {
  return item.unread ?? 0;
}

/**
 * 未読の印。**色だけに頼らない**（通知の記号と件数の数字を並べる）。読み上げには
 * 「未読 N 件」を1回だけ言う——視覚用の記号と数字は `aria-hidden` にして二重に読ませない。
 */
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
