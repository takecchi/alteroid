import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { TruncationNote } from '../../common';

export interface BarListItem {
  /** 行の識別と表示（モデル名・層・トークン id）。 */
  label: string;
  value: number;
  /** 名前を押して降りる先を描く（リンクにするのは画面。この層はルーターを知らない）。 */
  renderLabel?: (label: ReactNode) => ReactNode;
}

/**
 * 割合の帯つきの一覧（利用状況の層別・モデル別・トークン別など）。
 *
 * 行ごとに名前と値を出し、その下に**最大の行に対する長さ**の細い帯を敷く。
 * どこが量を食っているかが、数字を読み比べなくても分かる。
 *
 * - 並べ替えはしない（呼ぶ側が決めた順のまま。多い順で渡すのが普通）
 * - `limit` を超えた分は出さず、**切ったことを `TruncationNote` で言う**
 * - 値の文字は帯の色ではなく本文の色（色は帯だけが持つ）
 * - 帯は飾りなので読み上げから外す。値は文字で読める
 */
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
              key={item.label}
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
                  // 0 でない値が細すぎて消えないよう、最低でも 2px は見せる。
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
