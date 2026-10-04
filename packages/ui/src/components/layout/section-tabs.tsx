import type { ReactNode } from 'react';

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
  return (
    <nav aria-label={label} className="min-w-0">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
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
    </nav>
  );
}
