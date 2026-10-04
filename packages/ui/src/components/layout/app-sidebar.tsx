import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { BrandMark } from './brand-mark';
import { LiveIndicator, type LiveIndicatorStatus } from './live-indicator';

export interface AppSidebarItem {
  /** 行き先（`key` にも使う）。 */
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** 右端に添えるもの（件数の札など）。 */
  badge?: ReactNode;
  /**
   * 属するまとまりの見出し。**直前の行と違う値になったところで区切る**（並びの順が
   * そのまま見出しの順になる。まとまりを別の配列に分けないのは、行き先を1つ足すときに
   * 足す場所が2か所に割れないようにするため）。
   *
   * - 省略 —— 見出しの無い先頭のまとまり（いつも使う行き先）
   * - 空文字 —— 見出しを出さず、区切り線だけ引く（末尾の「設定」のように、まとまりの
   *   名前を言うほどではないが、上と混ぜたくないもの）
   */
  section?: string;
}

/**
 * 行き先1つぶんのリンクを描く口。
 *
 * **この層はルーターを知らない**（`common.tsx` の冒頭と同じ判断）。画面は
 * `NavLink` を置き、「いま居る画面か」を `className(isActive)` へ渡して見た目を
 * 受け取る。中身（記号・名前・札）は `children` として出来上がって渡る。
 */
export type AppSidebarRenderLink = (
  item: AppSidebarItem,
  slot: { className: (isActive: boolean) => string; children: ReactNode },
) => ReactNode;

/**
 * 行き先の一覧（脇の面）。
 *
 * **広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く**（`inDrawer`）。
 * 別々に書くと、行き先を1つ足したときに片方だけ増える。
 *
 * - `inDrawer` のときは枠・幅・左端の safe-area を付けない。**ドロワー
 *   （`drawer.tsx` の `SheetContent`）が既に持っている**ので、ここでも足すと
 *   二重に効く（余白が倍になる）
 * - `inDrawer` のときは行の高さを 44px 以上にする（指で押す先。WCAG 2.5.5 /
 *   Apple HIG の下限）
 * - いま居る画面は、左端の細い光の線と面の色で示す。**色だけに頼らない**
 *   （線の有無でも分かる）
 */
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
        /*
         * ドロワーの中では枠と幅は Drawer 側が持っている（左端の safe-area も含めて —
         * `drawer.tsx` の `SheetContent` に既にある）。**ここで同じものを足すと二重に効く**
         * （余白が倍になる）ので、`inDrawer` でない側（広い画面でこの `nav` が単独で
         * ページの左端に立つとき）にだけ足す。
         *
         * 横向きで画面幅が 768px（`useIsMobile` の境目）を超える端末では
         * `MobileTopBar` ではなくこちらが画面の左端に出る（`apps/web/app/routes/shell.tsx`
         * の `AuthedShell` 参照）。**現行の多くの機種は横向きでこの幅を超える**ので、
         * 横向きの左端の safe-area はむしろこちらが主な当たり先になる。右は当てていない
         * — 広い画面では `nav` の右に `main`（`page.tsx` / `chat.tsx`）が続き、画面の
         * 右端は既にそちら側の右の safe-area の calc() 版が持っている。
         *
         * ⚠️ ここで実際の角括弧つきのクラス名を書かないこと。Tailwind のスキャナは
         * コメントか本物のコードかを区別せず拾って壊れた CSS を生成する。実測: 移す前の
         * `shell.tsx` の `Nav` のコメントに、右の safe-area の calc() 版のクラス名を
         * 角括弧つきで一度書いたところ、コンパイル後の CSS に不正な calc()
         * （加算の項の前後に空白が無い形）がそのまま出た。使われない・壊れてもいない
         * ので実害は無かったが、次にここへ角括弧つきの例を書くときは注意すること。
         */
        inDrawer ? 'min-h-0 flex-1' : 'w-56 shrink-0 border-r border-border pl-[var(--safe-left)]',
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

/**
 * まとまりの始まり。見出しがあれば見出しを、空（または省略）なら区切り線だけを引く。
 * 見出しは `aria-hidden` にしない —— 読み上げでも「いまどのまとまりか」が分かるように
 * （リンクの並びの中に挟まる、ただの文として読まれる）。
 */
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

/** 行き先1つぶんの見た目。`AppSidebar` の外（見本・試験）からも同じものを使う。 */
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
