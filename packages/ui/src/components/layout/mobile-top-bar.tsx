import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';

import { BrandMark } from './brand-mark';
import {
  LiveIndicator,
  type LiveIndicatorConnection,
  type LiveIndicatorStatus,
} from './live-indicator';

export function MobileTopBar({
  status,
  connection,
  onOpenNav,
  trailing,
}: {
  status: LiveIndicatorStatus;
  connection?: LiveIndicatorConnection;
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
          <LiveIndicator status={status} connection={connection} className="mt-1 pl-7" />
        </div>

        {trailing}
      </div>
    </header>
  );
}
