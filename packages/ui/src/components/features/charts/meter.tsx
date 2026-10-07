import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

// `value` が `null` のとき 0 の帯にしない: 「まだ使っていない」と読めてしまうため
export function Meter({
  label,
  value,
  max,
  formatValue = (v) => String(v),
  hint,
  warnAt = 0.8,
  dangerAt = 1,
  unavailable = '取れない',
  className,
}: {
  label: ReactNode;
  value: number | null;
  max: number;
  formatValue?: (value: number) => string;
  hint?: ReactNode;
  warnAt?: number;
  dangerAt?: number;
  unavailable?: ReactNode;
  className?: string;
}) {
  const ratio = value === null || max <= 0 ? null : value / max;
  const tone =
    ratio === null ? 'none' : ratio >= dangerAt ? 'danger' : ratio >= warnAt ? 'warn' : 'ok';

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        {ratio !== null && (
          <span className="tabular-nums">
            {formatValue(value as number)}
            <span className="text-muted-foreground"> / {formatValue(max)}</span>
            <span
              className={cn(
                'ml-1.5',
                tone === 'danger' && 'text-destructive',
                tone === 'warn' && 'text-warn',
                tone === 'ok' && 'text-muted-foreground',
              )}
            >
              {Math.round(ratio * 100)}%
            </span>
          </span>
        )}
      </div>
      {ratio === null ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{unavailable}</p>
      ) : (
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={value as number}
          aria-label={typeof label === 'string' ? label : undefined}
          className={cn(
            'mt-1.5 h-1.5 overflow-hidden rounded-full',
            tone === 'danger' && 'bg-destructive/20',
            tone === 'warn' && 'bg-warn/20',
            tone === 'ok' && 'bg-primary/20',
          )}
        >
          <div
            className={cn(
              'h-full rounded-full',
              tone === 'danger' && 'bg-destructive',
              tone === 'warn' && 'bg-warn',
              tone === 'ok' && 'bg-primary',
            )}
            style={{ width: `${Math.min(100, ratio * 100).toFixed(2)}%` }}
          />
        </div>
      )}
      {hint !== undefined && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
