import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface KeyValueItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

// `break-all` は等幅（`mono`）の値だけに当てる: 全部に当てると、幅が足りていても語の途中で折れるため
// 先頭かどうかは添字で決める: 各項目は `contents` の要素で包むので、名前は常に包みの最初の子になり `first:` が全部に効いてしまうため
export function KeyValueList({
  items,
  labelWidth = '7rem',
  className,
}: {
  items: readonly KeyValueItem[];
  labelWidth?: string;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[var(--kv-label)_minmax(0,1fr)]',
        className,
      )}
      style={{ '--kv-label': labelWidth } as CSSProperties}
    >
      {items.map((item, index) => (
        <div
          key={item.key ?? (typeof item.label === 'string' ? item.label : index)}
          className="contents"
        >
          <dt
            className={cn('text-xs text-muted-foreground sm:pt-0.5', index > 0 && 'mt-3 sm:mt-0')}
          >
            {item.label}
          </dt>
          <dd
            className={cn(
              'min-w-0',
              item.mono === true ? 'font-mono text-xs break-all' : 'break-words',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
