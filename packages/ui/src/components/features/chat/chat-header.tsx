import { OctagonPause, PanelLeft } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '../../common';
import { DocumentTitle } from '../../document-title';
import { ConfirmDialog } from '../confirm-dialog';

/**
 * 会話の見出しの帯。
 *
 * - 副題は呼ぶ側が渡す利用者向けの情報（開始日時・発言数）。会話 id は出さない
 *   （利用者に意味が無く、狭い画面で切れる）。まだ決まっていなければ「新しい会話」
 * - `onOpenList` を渡すと、左に会話一覧を開く口を出す（狭い画面）
 * - 会話が決まっているときだけ「ターンを止める」「会話を終える」を出す。
 *   **「ターンを止める」はサーバ側のターンそのものを止める**（CLI の
 *   `alteroid interrupt` と同じ経路）。下の欄の「受信をやめる」とは別物である
 * - 「会話を終える」は押してもすぐには実行せず、何が起きるかを一文で見せる確認を挟む
 *   （title はタッチ端末で見えないので、用途の説明を確認文に持たせる）。
 *   会話は消えず一覧に残り、開けば続きを話せる。
 * - `notice` はターンを止めた結果など、帯のすぐ下に1行で出す事情
 */
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
  /** 見出しの下の1行（開始日時・発言数など）。無ければ出さない。 */
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
          <DocumentTitle>クローンと話す</DocumentTitle>
          <h1 className="text-base font-semibold">クローンと話す</h1>
          {(conversationId === undefined || subtitle !== undefined) && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {conversationId === undefined ? '新しい会話' : subtitle}
            </p>
          )}
        </div>
        {conversationId !== undefined && (onInterrupt !== undefined || onEnd !== undefined) && (
          <div className="flex shrink-0 items-center gap-3">
            {onInterrupt !== undefined && (
              /*
               * **「受信をやめる」（`ChatComposer`、入力欄の脇）とは別のボタン。** あちらは
               * この画面の購読を切るだけで、クローンのターンは走り続ける
               * （そのボタンの `title` が明言している）。これは `POST
               * /clone/interrupt` を叩いてサーバ側のターンそのものを止める
               * ——CLI の `alteroid interrupt` と同じ経路で、Web UI にだけ
               * 無かった口（#1398 c23-1/c30-2。入口の等価性）。
               *
               * **`sending`（この画面が受信中かどうか）では出し分けない。**
               * 走っているターンはこの画面が起こしたものとは限らない（別の
               * タブ・CLI・自律の起点から始まったターンも同じクローンの
               * ものである）。会話を持てるならこのボタンは常に押せてよい
               * ——資格の判定はサーバに委ね（`useInterruptClone` の doc）、
               * ここでは先回りして隠さない。
               */
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
          onConfirm={() => {
            setConfirmingEnd(false);
            onEnd();
          }}
        />
      )}
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
