import type { ComponentType, ReactNode } from 'react';

import { Card } from '../../common';

/**
 * ホームの「最新の日報」。**小さなカードの1枚ではなく、全幅の独立した枠**（日報はホームの主役の
 * ひとつ。人間が最初に読むものなので、抜粋ではなく Markdown で本文を読ませる）。
 *
 * - 本文（`children`。呼び出し側が `Markdown` で描く）は **最大 {@link HOME_REPORT_MAX_HEIGHT}
 *   で切り**、切った下端は薄れさせる。長い日報でもホームが縦に伸びきらない。全文は `footer`
 *   の行き先（日報のページ）が持つ。**短い日報では切れも薄れも目立たない**（背景色へ溶ける）
 * - 文字は本文の標準より一段大きい（`text-base`）。日報は流し読みでなく読むもの
 * - `min-w-0` を枠にも本文にも置く（#295。広い表や長い行がある日報で、親の grid を押し広げない）
 */
export const HOME_REPORT_MAX_HEIGHT = '24rem';

export function HomeReportCard({
  icon: Icon,
  title,
  meta,
  action,
  footer,
  children,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  /** 見出しの隣の小さな字（日付など）。 */
  meta?: ReactNode;
  /** 右上の行き先。 */
  action?: ReactNode;
  /** 本文の下の行（「続きを読む」など）。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
        {meta !== undefined && <span className="shrink-0">{meta}</span>}
        <span className="flex-1" />
        {action}
      </div>
      <div className="relative min-w-0 px-4 pt-3 pb-2">
        <div
          data-slot="home-report-body"
          className="max-h-96 min-w-0 overflow-hidden leading-relaxed [&>div]:text-base"
        >
          {children}
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-2 h-12"
          style={{ backgroundImage: 'linear-gradient(to top, var(--card), transparent)' }}
        />
      </div>
      {footer !== undefined && <div className="px-4 pb-3 text-xs">{footer}</div>}
    </Card>
  );
}
