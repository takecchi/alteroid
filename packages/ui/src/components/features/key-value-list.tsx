import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface KeyValueItem {
  /** 行の識別（既定は `label` が文字列ならそれ）。 */
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** 値を等幅で出す（識別子・パス・pid）。 */
  mono?: boolean;
}

/**
 * 名前と値の組の並び（`<dl>`）。接続先・マネージャーの属性・設定の中身。
 *
 * 広い画面では名前の列を `labelWidth` で固定して2列に、狭い画面では1列に
 * 積む（名前の下に値）。**値は折り返す** — パスや識別子は空白を持たないので、
 * `break-all` を付けないと枠を突き破る。
 *
 * **狭い画面（1列に積むとき）は、先頭以外の名前に上の余白を足して組の境目を作る**
 * （本4-A。理由は `apps/web/app/routes/manager-detail.test.tsx` の
 * 「横並びの積み替え（本4-A）」の doc）。各項目は `contents` の要素で包むので、名前は
 * 常に包みの最初の子になり `first:` が全部に効いてしまう ⟹ 先頭かどうかは添字で決める。
 */
export function KeyValueList({
  items,
  labelWidth = '7rem',
  className,
}: {
  items: readonly KeyValueItem[];
  /** 広い画面での名前の列の幅（CSS の長さ）。 */
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
          <dd className={cn('min-w-0 break-all', item.mono === true && 'font-mono text-xs')}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
