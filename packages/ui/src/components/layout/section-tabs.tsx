import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { TAB_TRIGGER_ACTIVE_CLASS, TAB_TRIGGER_CLASS } from '../common';

export interface SectionTab {
  to: string;
  label: string;
}

// リンクを描く口を受ける: この層はルーターを知らないため
export type SectionTabRenderLink = (
  tab: SectionTab,
  slot: { className: (isActive: boolean) => string; children: ReactNode },
) => ReactNode;

export function SectionTabs({
  label,
  tabs,
  renderLink,
}: {
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

  // `aria-current` の付け替えも見張る: ルートが変わっても帯が作り直されないことがあるため
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

const EDGE_EPSILON = 1;
const REVEAL_MARGIN = 32;

// `scrollIntoView` を使わず帯の `scrollLeft` だけを動かす: 祖先（ページ全体）まで動かしうるため
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
