import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';

import { BrandMark } from './brand-mark';
import { LiveIndicator, type LiveIndicatorStatus } from './live-indicator';

/**
 * 狭い画面の上端の帯。脇の面（`AppSidebar`）を畳んだ代わりに、印・受信の状態・
 * メニューを開く口を出す。
 *
 * `trailing` には**人間を待っているもの**（承認待ちの件数）を置く。脇の面を
 * 畳んだ結果、待ちが溜まっていることがどこにも見えなくなるのが一番まずい。
 *
 * 左右と上の safe-area はここで持つ（切り欠き・横向き）。
 */
export function MobileTopBar({
  status,
  onOpenNav,
  trailing,
}: {
  status: LiveIndicatorStatus;
  onOpenNav: () => void;
  trailing?: ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-border bg-card pt-[var(--safe-top)] pl-[var(--safe-left)] pr-[var(--safe-right)]">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="メニューを開く"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Menu className="size-5" aria-hidden />
        </button>

        <div className="min-w-0 flex-1">
          <BrandMark />
          <LiveIndicator status={status} className="mt-1 pl-7" />
        </div>

        {trailing}
      </div>
    </header>
  );
}
