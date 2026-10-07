import { cn } from '@/lib/utils';

const TONES = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-destructive',
  accent: 'bg-primary',
  neutral: 'bg-muted-foreground/50',
  'chart-1': 'bg-chart-1',
  'chart-2': 'bg-chart-2',
  'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4',
  other: 'bg-chart-5',
} as const;

export interface StackedBarSegment {
  key: string;
  label: string;
  value: number;
  tone: keyof typeof TONES;
}

// 合計が 0 なら帯を描かない: 0 の帯は「全部 0」とも「取れない」とも読めてしまうため
export function StackedBar({
  segments,
  formatValue = (value) => String(value),
  emptyText = 'まだ無い。',
  className,
}: {
  segments: readonly StackedBarSegment[];
  formatValue?: (value: number) => string;
  emptyText?: string;
  className?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const percent = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);

  if (total === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{emptyText}</p>;
  }

  const summary = segments
    .map(
      (segment) => `${segment.label} ${formatValue(segment.value)}（${percent(segment.value)}%）`,
    )
    .join('、');

  return (
    <div className={className}>
      <div role="img" aria-label={summary} className="flex h-2.5 w-full gap-0.5">
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment, index, visible) => (
            <div
              key={segment.key}
              className={cn(
                'h-full min-w-1',
                TONES[segment.tone],
                index === 0 && 'rounded-l-sm',
                index === visible.length - 1 && 'rounded-r-sm',
              )}
              style={{ flexGrow: segment.value, flexBasis: 0 }}
              title={`${segment.label} ${formatValue(segment.value)}`}
            />
          ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((segment) => (
          <li key={segment.key} className="inline-flex items-center gap-1.5">
            <span
              className={cn('size-2 shrink-0 rounded-[2px]', TONES[segment.tone])}
              aria-hidden
            />
            <span className="text-muted-foreground">{segment.label}</span>
            <span className="tabular-nums">{formatValue(segment.value)}</span>
            <span className="text-muted-foreground tabular-nums">{percent(segment.value)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
