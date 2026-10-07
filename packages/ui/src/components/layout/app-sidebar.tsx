import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { BrandMark } from './brand-mark';
import { LiveIndicator, type LiveIndicatorStatus } from './live-indicator';

export interface AppSidebarItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  badge?: ReactNode;
  // まとまりを別の配列に分けない: 行き先を1つ足すときに足す場所が2か所に割れるため
  section?: string;
}

// リンクを描く口を受ける: この層はルーターを知らないため
export type AppSidebarRenderLink = (
  item: AppSidebarItem,
  slot: { className: (isActive: boolean) => string; children: ReactNode },
) => ReactNode;

// 広い画面の脇と狭い画面のドロワーに同じものを置く: 別々に書くと、行き先を1つ足したときに片方だけ増えるため
export function AppSidebar({
  status,
  items,
  renderLink,
  footer,
  inDrawer = false,
}: {
  status: LiveIndicatorStatus;
  items: readonly AppSidebarItem[];
  renderLink: AppSidebarRenderLink;
  footer?: ReactNode;
  inDrawer?: boolean;
}) {
  return (
    <nav
      className={cn(
        'flex flex-col bg-card',
        // `inDrawer` では枠・幅・左端の safe-area を付けない: Drawer が既に持っており、足すと二重に効くため
        inDrawer
          ? 'min-h-0 flex-1'
          : 'w-56 shrink-0 border-r border-border pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]',
      )}
    >
      <div className="px-4 pt-4 pb-3">
        <BrandMark />
        <LiveIndicator status={status} className="pl-7" />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {items.map((item, index) => {
          const Icon = item.icon;
          const startsSection = index > 0 && item.section !== items[index - 1]?.section;
          return (
            <li key={item.to}>
              {startsSection ? <SectionStart label={item.section} inDrawer={inDrawer} /> : null}
              {renderLink(item, {
                className: (isActive) => sidebarLinkClassName({ isActive, inDrawer }),
                children: (
                  <>
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge}
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>

      {footer}
    </nav>
  );
}

// 見出しを `aria-hidden` にしない: 読み上げでも「いまどのまとまりか」が分かるように
function SectionStart({ label, inDrawer }: { label: string | undefined; inDrawer: boolean }) {
  if (label === undefined || label.length === 0) {
    return <div role="separator" className="mx-2.5 my-2 border-t border-border" />;
  }
  return (
    <p
      className={cn(
        'px-2.5 pb-1 text-[11px] tracking-wide text-muted-foreground/80',
        inDrawer ? 'pt-4' : 'pt-3',
      )}
    >
      {label}
    </p>
  );
}

export function sidebarLinkClassName({
  isActive,
  inDrawer,
}: {
  isActive: boolean;
  inDrawer: boolean;
}): string {
  return cn(
    'mb-0.5 flex items-center gap-2.5 rounded-sm px-2.5 text-sm transition-colors',
    inDrawer ? 'min-h-11' : 'py-1.5',
    isActive
      ? 'lumen-edge bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );
}
