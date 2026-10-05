/**
 * 一覧＋詳細の共通レイアウト。会話の画面（左に会話一覧、右に会話）と同じ作りを、
 * 他の「一覧から1件を選んで読む」画面でも使い回すための骨組み。
 *
 * - 広い画面（md 以上）: 左に一覧、右に詳細。どちらもペインの中で独立にスクロールする。
 * - 狭い画面: 未選択なら一覧を全幅で出す。選択があれば詳細を全幅で出し、上端の
 *   「〈一覧の名前〉を開く」ボタンで一覧をドロワーに出す（項目を押すと閉じる）。
 *
 * **高さは親から受ける（`h-full`）。** 親は余白もスクロールも持たない本文であること。
 * **ルーターを知らない層**なので、リンクは `ListDetailItems` の `renderLink` で受ける。
 * 画面の h1 は外側の `Page` が持つ。詳細側の見出しは呼ぶ側が h2 で渡す。
 */
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

/** Page の本文と同じ余白（safe-area 込み）。 */
const DETAIL_PADDING =
  'p-4 pb-[calc(1rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]';

/**
 * - `listLabel` —— 一覧の名前。一覧の見出し（h2）・`<nav>` の名前・スマホのボタンの文言に使う
 * - `list` —— 一覧の中身（`ListDetailItems` など）
 * - `detail` —— 詳細の中身
 * - `hasSelection` —— 詳細に何か選ばれているか
 * - `selectionKey` —— 選択の識別子。スマホで変わったら詳細の先頭へ焦点を移す
 * - `detailLabel` —— 詳細の領域の名前（既定は「〈一覧の名前〉の詳細」）
 * - `emptyDetail` —— 広い画面で未選択のときの案内
 * - `listFooter` —— 一覧の下端（「さらに読む」など。一覧のスクロールの外に固定される）
 */
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

  // 広い画面へ変わったらドロワーは要らない。
  const drawerShown = drawerOpen && isMobile && hasSelection;

  // スマホで選択が変わったら詳細の先頭へ焦点を移す（広い画面では一覧の焦点を奪わない）。
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!isMobile || !hasSelection) return;
    // ドロワーが閉じるときの焦点の戻しの後に勝つよう、1フレーム待つ。
    const id = requestAnimationFrame(() => detailRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [selectionKey, isMobile, hasSelection]);

  const listPane = (inDrawer: boolean) => (
    <aside
      className={cn(
        'flex min-h-0 flex-col bg-card',
        inDrawer ? 'flex-1' : isMobile ? 'flex-1' : 'w-64 shrink-0 border-r border-border md:w-72',
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
  /** いま詳細に開いている項目か。 */
  current: boolean;
  children: ReactNode;
}

/** 1行ぶんのリンクを描く口。ルーターを知らない層なので、画面が `<Link>` を置く。 */
export type ListDetailRenderLink = (props: {
  href: string;
  className: string;
  children: ReactNode;
  'aria-current': 'page' | undefined;
  onClick: MouseEventHandler<HTMLAnchorElement>;
}) => ReactNode;

/**
 * 一覧の中身。各行がリンクで、選択中は `aria-current="page"` と強調。
 * 一覧の中で ↑/↓（前後）・Home/End（先頭/末尾）で焦点だけを移す（開くのは Enter）。
 * 選択中の項目が見えない位置にあるときは、初回の描画で見える位置へ寄せる（焦点は移さない）。
 */
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
      {items.map((item) => (
        <li key={item.key}>
          {renderLink({
            href: item.href,
            className: cn(
              'block border-b border-border px-3 py-2 text-sm transition-colors hover:bg-muted',
              item.current && 'lumen-edge bg-accent text-accent-foreground',
            ),
            children: item.children,
            'aria-current': item.current ? 'page' : undefined,
            onClick: onNavigate,
          })}
        </li>
      ))}
    </ul>
  );
}
