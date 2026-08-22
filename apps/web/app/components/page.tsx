import type { ReactNode, Ref } from 'react';

import { cn } from '~/lib/cn';

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
  description,
  action,
  className,
  scrollRef,
  children,
}: {
  title: ReactNode;
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
  children: ReactNode;
}) {
  return (
    /*
     * **`h-dvh` ではなく `h-full`。** 高さの出どころは `AuthedShell` の `h-dvh` 1つに
     * まとめてある。ここでも viewport を取ると、狭い画面で上端に出す帯のぶんだけ
     * 画面からはみ出す（帯は shell が持っていて、この部品からは見えない）。
     */
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-4 md:px-6">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          {/*
            **上限は歯止めであって、置き場を認めるものではない**（真上の doc）。
            それでも長いものが渡ったときに本文を全部押し出さないよう、伸びる先を
            この中のスクロールへ閉じ込める。**文字は1つも捨てない** — `line-clamp`
            で切ると、header に収まっているように見えたまま読めない部分ができる。
          */}
          {description !== undefined && (
            <p className="mt-0.5 max-h-16 overflow-y-auto text-xs text-muted">{description}</p>
          )}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      {/*
        狭い画面では左右の余白を削る。**24px×2 は幅 375px の 13% を食う**ので、
        表や生ログが読めなくなる側の効き方をする。下端は切り欠きのぶんだけ足す。
      */}
      <div
        ref={scrollRef}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+var(--safe-bottom))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))]',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
