import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { TruncationNote } from '../../common';

export interface BarListItem {
  label: string;
  id?: string | undefined;
  value: number;
  // リンクを `renderLabel` で受ける: この層はルーターを知らないため
  renderLabel?: (label: ReactNode) => ReactNode;
}

export function BarList({
  items,
  formatValue = (value) => String(value),
  limit,
  empty = '無し。',
  className,
}: {
  items: readonly BarListItem[];
  formatValue?: (value: number) => string;
  limit?: number;
  empty?: ReactNode;
  className?: string;
}) {
  const shown = limit === undefined ? items : items.slice(0, limit);
  const max = Math.max(0, ...items.map((item) => item.value));

  if (shown.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">{empty}</p>;
  }

  return (
    <div className={className}>
      <ul>
        {shown.map((item) => {
          const ratio = max > 0 ? item.value / max : 0;
          return (
            <li
              key={item.id ?? item.label}
              className="border-b border-border px-4 py-2 text-sm last:border-b-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                  title={item.label}
                >
                  {item.renderLabel === undefined ? item.label : item.renderLabel(item.label)}
                </span>
                <span className="shrink-0 tabular-nums">{formatValue(item.value)}</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  className={cn('h-full rounded-full bg-chart-1', ratio === 0 && 'hidden')}
                  // 最低 2px は見せる: 0 でない値が細すぎて消えないため
                  style={{ width: `max(2px, ${(ratio * 100).toFixed(2)}%)` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {limit !== undefined && <TruncationNote shown={limit} total={items.length} />}
    </div>
  );
}
