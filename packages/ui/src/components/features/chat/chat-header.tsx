import { OctagonPause, PanelLeft } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '../../common';
import { DocumentTitle } from '../../document-title';
import { ConfirmDialog } from '../confirm-dialog';

// 会話 id を出さない: 利用者に意味が無く、狭い画面で切れるため
export function ChatHeader({
  conversationId,
  subtitle,
  onOpenList,
  onInterrupt,
  interrupting = false,
  onEnd,
  ending = false,
  notice,
}: {
  conversationId: string | undefined;
  subtitle?: string | undefined;
  onOpenList?: () => void;
  onInterrupt?: () => void;
  interrupting?: boolean;
  onEnd?: () => void;
  ending?: boolean;
  notice?: ReactNode;
}) {
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const gutter =
    'pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]';
  return (
    <>
      <header
        data-conversation-id={conversationId}
        className={`flex shrink-0 items-center justify-between gap-4 border-b border-border py-4 md:pt-[calc(1rem+var(--safe-top))] ${gutter}`}
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
          <DocumentTitle>会話</DocumentTitle>
          <h1 className="text-base font-semibold">会話</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            クローンと話す
            {(conversationId === undefined || subtitle !== undefined) && (
              <>
                {' · '}
                <span>{conversationId === undefined ? '新しい会話' : subtitle}</span>
              </>
            )}
          </p>
        </div>
        {conversationId !== undefined && (onInterrupt !== undefined || onEnd !== undefined) && (
          <div className="flex shrink-0 items-center gap-3">
            {onInterrupt !== undefined && (
              // `sending` では出し分けない: 走っているターンはこの画面が起こしたものとは限らないため
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
                onClick={() => setConfirmingEnd(true)}
                data-chat-end
                loading={ending}
                title="クローンがここまでの学びを記憶にまとめる"
              >
                会話を終える
              </Button>
            )}
          </div>
        )}
      </header>
      {onEnd !== undefined && (
        <ConfirmDialog
          open={confirmingEnd}
          onOpenChange={setConfirmingEnd}
          title="この会話を終えますか"
          description="クローンがここまでの学びを記憶にまとめます。会話は一覧に残り、あとから開いて続きを話せます。"
          confirmLabel="終える"
          cancelLabel="やめる"
          // 既定の戻し先にしない: 押した直後に disabled になる・押す前にフォーカスが無い（Safari）と、body へ落ちて迷子になるため
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLElement>('[data-chat-end]')?.focus();
          }}
          onConfirm={() => {
            setConfirmingEnd(false);
            onEnd();
          }}
        />
      )}
      {notice !== undefined && (
        <p
          role="status"
          className={`shrink-0 border-b border-border py-2 text-[11px] text-muted-foreground ${gutter}`}
        >
          {notice}
        </p>
      )}
    </>
  );
}
