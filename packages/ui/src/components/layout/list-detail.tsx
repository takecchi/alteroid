import { PanelLeft } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEventHandler,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import { useIsMobile } from '../../hooks/use-is-mobile';
import { Drawer } from '../drawer';

const ListDetailContext = createContext<{ onNavigate: () => void }>({ onNavigate: () => {} });

const DETAIL_PADDING =
  'p-4 pb-[calc(1rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]';

// リンクを `ListDetailItems` の `renderLink` で受ける: この層はルーターを知らないため
export function ListDetail({
  listLabel,
  list,
  detail,
  hasSelection,
  selectionKey,
  detailLabel,
  emptyDetail,
  listFooter,
  className,
}: {
  listLabel: string;
  list: ReactNode;
  detail: ReactNode;
  hasSelection: boolean;
  selectionKey?: string;
  detailLabel?: string;
  emptyDetail?: ReactNode;
  listFooter?: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const shownKey = useRef(selectionKey);

  const drawerShown = drawerOpen && isMobile && hasSelection;

  // 焦点はスマホだけで移す: 広い画面では一覧の焦点を奪うため
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!isMobile || !hasSelection) return;
    // 1フレーム待つ: ドロワーが閉じるときの焦点の戻しに勝つため
    const id = requestAnimationFrame(() => detailRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [selectionKey, isMobile, hasSelection]);

  useEffect(() => {
    if (shownKey.current === selectionKey) return;
    shownKey.current = selectionKey;
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selectionKey]);

  const listPane = (inDrawer: boolean) => (
    <aside
      className={cn(
        'flex min-h-0 flex-col bg-card',
        inDrawer
          ? 'flex-1'
          : isMobile
            ? 'min-w-0 flex-1'
            : 'w-64 shrink-0 border-r border-border md:w-72',
      )}
    >
      <h2 className="shrink-0 border-b border-border px-3 py-3 text-sm font-semibold">
        {listLabel}
      </h2>
      <nav aria-label={listLabel} className="min-h-0 flex-1 overflow-y-auto">
        {list}
      </nav>
      {listFooter !== undefined && (
        <div className="shrink-0 border-t border-border">{listFooter}</div>
      )}
    </aside>
  );

  if (isMobile && !hasSelection) {
    return (
      <ListDetailContext.Provider value={{ onNavigate: () => {} }}>
        <div className={cn('flex h-full min-h-0', className)}>{listPane(false)}</div>
      </ListDetailContext.Provider>
    );
  }

  return (
    <ListDetailContext.Provider value={{ onNavigate: () => setDrawerOpen(false) }}>
      <div className={cn('flex h-full min-h-0', className)}>
        {!isMobile && listPane(false)}
        <div className="flex min-w-0 flex-1 flex-col">
          {isMobile && (
            <div className="flex shrink-0 items-center border-b border-border pl-[var(--safe-left)] pr-[var(--safe-right)]">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="flex min-h-11 items-center gap-2 px-4 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <PanelLeft className="size-5" aria-hidden />
                {listLabel}を開く
              </button>
            </div>
          )}
          <section
            ref={detailRef}
            tabIndex={-1}
            aria-label={detailLabel ?? `${listLabel}の詳細`}
            className={cn('min-h-0 flex-1 overflow-y-auto outline-none', DETAIL_PADDING)}
          >
            {hasSelection ? detail : emptyDetail}
          </section>
        </div>
        {isMobile && (
          <Drawer open={drawerShown} onClose={() => setDrawerOpen(false)} label={listLabel}>
            {listPane(true)}
          </Drawer>
        )}
      </div>
    </ListDetailContext.Provider>
  );
}

export interface ListDetailItem {
  key: string;
  href: string;
  current: boolean;
  className?: string;
  children: ReactNode;
  // 行の一部だけをリンクにする: 行全体がリンクだと、中の文字をドラッグで選べないため
  extra?: ReactNode;
  lead?: ReactNode;
}

export type ListDetailRenderLink = (props: {
  href: string;
  className: string;
  children: ReactNode;
  'aria-current': 'page' | undefined;
  onClick: MouseEventHandler<HTMLAnchorElement>;
}) => ReactNode;

export function ListDetailItems({
  items,
  renderLink,
  label,
}: {
  items: readonly ListDetailItem[];
  renderLink: ListDetailRenderLink;
  label: string;
}) {
  const { onNavigate } = useContext(ListDetailContext);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const links = Array.from(listRef.current?.querySelectorAll<HTMLElement>('a[href]') ?? []);
    const index = links.findIndex((link) => link === document.activeElement);
    if (index < 0) return;
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, links.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = links.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    links[next]?.focus();
  };

  return (
    <ul ref={listRef} aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) =>
        item.extra !== undefined || item.lead !== undefined ? (
          <li
            key={item.key}
            className={cn(
              'border-b border-border px-3 py-2 text-sm transition-colors hover:bg-muted',
              item.current && 'lumen-edge bg-accent text-accent-foreground',
              item.className,
            )}
          >
            <div className="flex items-baseline">
              {item.lead}
              {renderLink({
                href: item.href,
                className:
                  '-my-1 block min-w-0 flex-1 truncate py-1 underline-offset-2 hover:underline',
                children: item.children,
                'aria-current': item.current ? 'page' : undefined,
                onClick: onNavigate,
              })}
            </div>
            {item.extra}
          </li>
        ) : (
          <li key={item.key}>
            {renderLink({
              href: item.href,
              className: cn(
                'block border-b border-border px-3 py-2 text-sm transition-colors hover:bg-muted',
                item.current && 'lumen-edge bg-accent text-accent-foreground',
                item.className,
              ),
              children: item.children,
              'aria-current': item.current ? 'page' : undefined,
              onClick: onNavigate,
            })}
          </li>
        ),
      )}
    </ul>
  );
}
