import type { ReactNode } from 'react';

import { cn } from '~/lib/cn';

export function Page({
  title,
  description,
  action,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
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
          {description !== undefined && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      {/*
        狭い画面では左右の余白を削る。**24px×2 は幅 375px の 13% を食う**ので、
        表や生ログが読めなくなる側の効き方をする。下端は切り欠きのぶんだけ足す。
      */}
      <div
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
