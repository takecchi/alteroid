import { OctagonPause, PanelLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../common';

/**
 * 会話の見出しの帯。
 *
 * - 会話 id を等幅で出す（まだ決まっていなければ「新しい会話」）
 * - `onOpenList` を渡すと、左に会話一覧を開く口を出す（狭い画面）
 * - 会話が決まっているときだけ「ターンを止める」「会話を終える」を出す。
 *   **「ターンを止める」はサーバ側のターンそのものを止める**（CLI の
 *   `alteroid interrupt` と同じ経路）。下の欄の「受信をやめる」とは別物である
 * - `notice` はターンを止めた結果など、帯のすぐ下に1行で出す事情
 */
export function ChatHeader({
  conversationId,
  onOpenList,
  onInterrupt,
  interrupting = false,
  onEnd,
  ending = false,
  notice,
}: {
  conversationId: string | undefined;
  onOpenList?: () => void;
  onInterrupt?: () => void;
  interrupting?: boolean;
  onEnd?: () => void;
  ending?: boolean;
  notice?: ReactNode;
}) {
  const gutter =
    'pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]';
  return (
    <>
      <header
        className={`flex shrink-0 items-center justify-between gap-4 border-b border-border py-4 ${gutter}`}
      >
        {onOpenList !== undefined && (
          <button
            type="button"
            onClick={onOpenList}
            aria-label="会話一覧を開く"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelLeft className="size-5" aria-hidden />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">クローンと話す</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {conversationId ?? '新しい会話'}
          </p>
        </div>
        {conversationId !== undefined && (onInterrupt !== undefined || onEnd !== undefined) && (
          <div className="flex shrink-0 items-center gap-2">
            {onInterrupt !== undefined && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onInterrupt}
                loading={interrupting}
                title="いま走っているクローンのターンだけを止める。会話とセッションはそのまま残り、次の合図で次のターンが始まる"
                aria-label="クローンのターンを止める"
              >
                <OctagonPause className="size-3.5" aria-hidden />
                <span className="hidden md:inline">ターンを止める</span>
              </Button>
            )}
            {onEnd !== undefined && (
              <Button
                size="sm"
                onClick={onEnd}
                loading={ending}
                title="クローンがここまでの学びを記憶へ蒸留する"
              >
                会話を終える
              </Button>
            )}
          </div>
        )}
      </header>
      {notice !== undefined && (
        <p
          className={`shrink-0 border-b border-border py-2 text-[11px] text-muted-foreground ${gutter}`}
        >
          {notice}
        </p>
      )}
    </>
  );
}
