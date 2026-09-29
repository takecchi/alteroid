import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'bg-muted-foreground',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-destructive',
  accent: 'bg-primary',
} as const;

/**
 * 状態の点と文言（稼働中・待機・失敗）。札（`Badge`）より静かに状態を言いたい
 * とき——一覧の行の中など、札が並ぶと行ごとに目を引いてしまう場所で使う。
 *
 * **色だけで状態を言わない。** 文言（`children`）が本体で、点は添え物である
 * （色の見分けが付かない人にも、読み上げにも同じことが伝わる）。
 */
export function StatusDot({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', TONES[tone])} aria-hidden />
      {children}
    </span>
  );
}
