import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'text-foreground',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-destructive',
  accent: 'text-primary',
} as const;

// `font-display`（Michroma）を使わない: 0 と O が同じ形で見分けられず、件数・金額・id を読み違えるため
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-1.5">
        <span
          data-numeric
          className={cn('text-2xl leading-none font-medium tabular-nums', TONES[tone])}
        >
          {value}
        </span>
        {unit !== undefined && <span className="text-xs text-muted-foreground">{unit}</span>}
      </p>
      {hint !== undefined && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
