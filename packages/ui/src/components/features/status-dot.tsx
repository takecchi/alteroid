import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'bg-muted-foreground',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-destructive',
  accent: 'bg-primary',
} as const;

// 色だけで状態を言わない: 色の見分けが付かない人にも、読み上げにも同じことが伝わるように、文言（`children`）を本体にするため
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
