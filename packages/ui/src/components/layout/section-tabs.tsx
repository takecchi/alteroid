import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { TAB_TRIGGER_ACTIVE_CLASS, TAB_TRIGGER_CLASS } from '../common';

export interface SectionTab {
  /** 行き先（`key` にも使う）。 */
  to: string;
  label: string;
}

/**
 * タブ1つぶんのリンクを描く口。`AppSidebarRenderLink` と同じ形（**この層はルーターを
 * 知らない**。画面が `NavLink` を置き、「いま居る画面か」を `className(isActive)` へ渡す）。
 */
export type SectionTabRenderLink = (
  tab: SectionTab,
  slot: { className: (isActive: boolean) => string; children: ReactNode },
) => ReactNode;

/**
 * サイドバーの1行へ畳んだ「まとまり」の中の行き先を行き来するタブの帯（仕事・日誌・
 * 設定など）。**行き先は1つも消していない。** サイドバーが1行にしたぶん、同じまとまりの
 * 他のページへはここから行く。
 *
 * - 各ページの先頭（見出しの下）に置く（`Page` の `tabs`）
 * - 狭い画面では折り返さず横にスクロールする（タブの数が多い「設定」でも1行に収める）
 * - **選んでいるタブが帯の外にあれば、帯だけを横へ動かして見える位置へ寄せる**（ページ全体は
 *   動かさない。`scrollIntoView` ではなく帯の `scrollLeft` を直接決める）
 * - 左右に続きがあるときは、その端にフェードを出す（`data-edge="start" | "end"`）
 * - いま居る画面は下線と `aria-current` で示す（色だけに頼らない）
 */
export function SectionTabs({
  label,
  tabs,
  renderLink,
}: {
  /** ナビゲーションの名前（読み上げ用。例: 「仕事のページ」）。 */
  label: string;
  tabs: readonly SectionTab[];
  renderLink: SectionTabRenderLink;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measureEdges = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const start = list.scrollLeft > EDGE_EPSILON;
    const end = list.scrollLeft + list.clientWidth < list.scrollWidth - EDGE_EPSILON;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // 選んでいるタブへ寄せる。ルートが変わっても帯が作り直されないことがあるので、
  // 選択中の印（`aria-current`）の付け替えも見張る。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      revealActiveTab(list);
      measureEdges();
    };
    reveal();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(reveal);
    observer.observe(list, { attributes: true, attributeFilter: ['aria-current'], subtree: true });
    return () => observer.disconnect();
  }, [tabs, measureEdges]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.addEventListener('scroll', measureEdges, { passive: true });
    window.addEventListener('resize', measureEdges);
    return () => {
      list.removeEventListener('scroll', measureEdges);
      window.removeEventListener('resize', measureEdges);
    };
  }, [measureEdges]);

  return (
    <nav aria-label={label} className="relative min-w-0">
      <ul ref={listRef} className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <li key={tab.to} className="shrink-0">
            {renderLink(tab, {
              className: (isActive) =>
                cn(
                  TAB_TRIGGER_CLASS,
                  'inline-block whitespace-nowrap',
                  isActive && TAB_TRIGGER_ACTIVE_CLASS,
                ),
              children: tab.label,
            })}
          </li>
        ))}
      </ul>
      {edges.start && (
        <span
          aria-hidden
          data-edge="start"
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent"
        />
      )}
      {edges.end && (
        <span
          aria-hidden
          data-edge="end"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent"
        />
      )}
    </nav>
  );
}

/** 端の判定の誤差（小数のスクロール位置で、端に着いているのに続きがあると出さないため）。 */
const EDGE_EPSILON = 1;
/** 選んでいるタブの左右に残す余白（隣のタブの頭を見せて、続きがあると分かるようにする）。 */
const REVEAL_MARGIN = 32;

/**
 * 選んでいるタブ（`aria-current`）が帯の見える範囲に収まるよう、**帯の `scrollLeft` だけ**を
 * 動かす。`scrollIntoView` は祖先（ページ全体）まで動かしうるので使わない。
 * すでに余白つきで収まっていれば何もしない。
 */
function revealActiveTab(list: HTMLElement): void {
  const active = list.querySelector<HTMLElement>('[aria-current]');
  if (!active) return;
  const listRect = list.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  const left = rect.left - listRect.left + list.scrollLeft;
  const right = left + rect.width;
  const viewLeft = list.scrollLeft;
  const viewRight = viewLeft + list.clientWidth;
  let next = viewLeft;
  if (left - REVEAL_MARGIN < viewLeft) next = left - REVEAL_MARGIN;
  else if (right + REVEAL_MARGIN > viewRight) next = right + REVEAL_MARGIN - list.clientWidth;
  next = Math.max(0, Math.min(next, list.scrollWidth - list.clientWidth));
  if (next !== viewLeft) list.scrollLeft = next;
}
