import type { MouseEvent } from 'react';

import { cn } from '@/lib/utils';

/** 本文（`<main>`）の `id`。`SkipLink` の飛び先で、shell が `<main id=...>` に付ける。 */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * 「本文へ移動」。**Tab の最初の1回で出る**（フォーカスしたときだけ見える）。
 *
 * 押すと `<main>` へフォーカスを移し、本文のスクロール領域（`data-scroll-body`）を先頭へ
 * 戻す。次の Tab は `<main>` の中の最初の操作部品へ進む（ナビを通らない）。
 * URL の `#` は書き換えない（ルーターの履歴を汚さない）。
 */
export function SkipLink({ className }: { className?: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (main === null) return;
    event.preventDefault();
    main.focus({ preventScroll: true });
    main.querySelector<HTMLElement>('[data-scroll-body]')?.scrollTo?.({ top: 0 });
  };
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={onClick}
      className={cn(
        'sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground',
        className,
      )}
    >
      本文へ移動
    </a>
  );
}
