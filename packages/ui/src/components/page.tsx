import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import { cn } from '@/lib/utils';

import { DocumentTitle } from './document-title';

/**
 * 画面の枠（見出しの帯＋スクロールする本文）。
 *
 * **`description` は画面の見出しに添える固定の一文である。** 可変長の本文
 * （依頼の全文・報告・ログ）をここへ渡さないこと — header は `shrink-0` なので、
 * 渡した文字数のぶんだけ本文の領域が縦に潰れる。実際に `manager-detail` が
 * `manager.request` をそのまま渡していて、長い依頼では状態カードが画面に入らな
 * かった。**本文は `children` 側へ置けば、伸びるのはスクロールできる側になる。**
 */
export function Page({
  title,
  documentTitle,
  description,
  action,
  className,
  scrollRef,
  tabs,
  children,
}: {
  title: ReactNode;
  /**
   * タブの題名に使う画面名。`title` が文字列ならそれを使うので、**文字列の `title` の画面は
   * 渡さない**（h1 と題名が同じ出どころになる）。`title` が部品（パンくず）のときだけ渡す。
   * UUID や英語の内部識別子は入れない（利用者が自分で付けた名前は可）。
   */
  documentTitle?: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /**
   * スクロールする本文の div へそのまま渡す。**既定は無し**（渡さない画面は
   * 何も変わらない）。
   *
   * 日誌画面（`routes/journal.tsx`）が `virtua` の `Virtualizer` へ
   * `scrollRef` を渡すために要る — `Virtualizer` の既定のスクロール対象は
   * 「直接の親要素」だが、この div と `Virtualizer` のあいだにチップ帯や
   * `ErrorNote` を挟むので、直接の親では足りない（virtua の doc:
   * `scrollRef` を渡さないと「the direct parent element of virtualizer」を
   * 見る）。ここでスクロール領域そのものの ref を渡せるようにしておけば、
   * `Page` の内側スクロール1本をそのまま virtua の対象にでき、スクロール
   * バーが増えない。
   */
  scrollRef?: Ref<HTMLDivElement>;
  /**
   * 見出しの下に置く、同じまとまりの他のページへ行くタブの帯（`SectionTabs`）。
   * **スクロールしない側**に置く（本文を流しても、行き先は見えたまま）。
   */
  tabs?: ReactNode;
  children: ReactNode;
}) {
  const docTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  return (
    /*
     * **`h-dvh` ではなく `h-full`。** 高さの出どころは `AuthedShell` の `h-dvh` 1つに
     * まとめてある。ここでも viewport を取ると、狭い画面で上端に出す帯のぶんだけ
     * 画面からはみ出す（帯は shell が持っていて、この部品からは見えない）。
     */
    <div className="flex h-full flex-col">
      {docTitle !== undefined && <DocumentTitle>{docTitle}</DocumentTitle>}
      <header
        className={cn(
          // タブの帯があるときは、区切り線を帯の下の1本にする（線が2本続かないように）。
          tabs === undefined && 'border-b border-border',
          'flex shrink-0 items-start justify-between gap-4 py-4 md:pt-[calc(1rem+var(--safe-top))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]',
        )}
      >
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          {description !== undefined && <PageDescription>{description}</PageDescription>}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      {tabs !== undefined && (
        <div className="shrink-0 border-b border-border pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]">
          {tabs}
        </div>
      )}
      {/*
        狭い画面では左右の余白を削る。**24px×2 は幅 375px の 13% を食う**ので、
        表や生ログが読めなくなる側の効き方をする。下端は切り欠きのぶんだけ足す。
      */}
      <div
        ref={scrollRef}
        data-scroll-body
        className={cn(
          // **`relative` は外せない**（body が余計にスクロールする不具合の原因を塞ぐ）。
          // 本文の中の `sr-only`（`position: absolute`）は、祖先に位置の基準が無いと初期の
          // 包含ブロック（文書）へ付き、本文を流した位置のぶんだけ文書の下に1px 要素が残って
          // body がスクロールする。この枠を基準にすれば、枠の `overflow` の中へ閉じる。
          'relative min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 見出しの説明文。**3行ぶんの高さで畳み、全文は「詳しく」で開く。**
 *
 * 以前は `max-h-16 overflow-y-auto`（枠の中をスクロール）だった。長い説明が本文を押し出さない
 * 歯止め（#147）としては効いたが、Chromium は「キーボードで届くものを持たないスクロール枠」を
 * 自動で Tab の対象にするので、押しても何も起きない停止が1つ増え、スクロールできる手がかりも
 * 無かった（#2810）。ここは `overflow: hidden` の畳みにして**スクロール枠を持たず**、
 * 畳まれて切れているときだけボタンを出す。畳んでも文字は DOM に全部在る（読み上げには全文が届く）。
 */
function PageDescription({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, open]);

  return (
    <>
      <p
        ref={ref}
        id={id}
        className={cn('mt-0.5 text-xs text-muted-foreground', !open && 'max-h-12 overflow-hidden')}
      >
        {children}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs text-muted-foreground underline hover:text-foreground"
        >
          {open ? 'たたむ' : '詳しく'}
        </button>
      )}
    </>
  );
}
