import type { ComponentType, ReactNode } from 'react';

import { Card } from '../../common';

/**
 * ホームの小さなカード（最新の日報・作業の進捗・次の自動実行・今日の利用）。
 * 各ページへの入口で、数字は1〜2個だけ置く。詳しくは行き先のページが持つ。
 */
export function HomeTile({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  /** 右上の行き先（`HOME_LINK_CLASS` のリンク）。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <h2 className="flex-1 truncate font-normal">{title}</h2>
        {action}
      </div>
      <div className="min-w-0 px-4 pt-2 pb-3">{children}</div>
    </Card>
  );
}

/** タイル用の短い注記（取れない理由・数が下限であることなど）。 */
export function HomeTileNote({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'warn';
  children: ReactNode;
}) {
  return (
    <p
      className={tone === 'warn' ? 'mt-2 text-xs text-warn' : 'mt-2 text-xs text-muted-foreground'}
    >
      {children}
    </p>
  );
}
