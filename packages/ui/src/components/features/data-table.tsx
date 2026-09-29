import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';

import { Empty } from '../common';

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** 並べ替えに使う値。渡した列だけ見出しを押して並べ替えられる。 */
  sortValue?: (row: Row) => string | number | null;
  align?: 'left' | 'right';
  /** 狭い画面の積んだ形で、名前の段を出さない（本文そのものの列など）。 */
  hideLabelOnMobile?: boolean;
  className?: string;
}

type Sort = { key: string; direction: 'asc' | 'desc' } | null;

/**
 * 並べ替えられる表（マネージャーの一覧・利用状況のマネージャー別）。
 *
 * - 見出しを押すと 昇順 → 降順 → 元の順 と回る。並べ替えの状態は `aria-sort` でも言う
 * - **並べ替えの値が無い行（`null`）は、向きに関係なく末尾へ置く**（無い値を 0 や
 *   空文字として先頭に混ぜない）
 * - **狭い画面（`md` 未満）では表をやめて、行ごとに名前と値を積んだ札にする。**
 *   列の多い表を横スクロールさせると、どの行を見ているかを見失う。**どちらを描くかは
 *   `useIsMobile` で決める**（CSS の `md:hidden` で隠す形にすると、jsdom は CSS を
 *   評価しないので試験で両方が描かれて見える。`drawer.tsx` と同じ判断）
 * - 行を押して詳細へ降りる口は、呼ぶ側がセルの中にリンクで置く
 */
export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  initialSort = null,
  empty = '無し。',
  caption,
  className,
}: {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  initialSort?: Sort;
  empty?: ReactNode;
  /** 表の名前（読み上げ用。見た目には出さない）。 */
  caption?: string;
  className?: string;
}) {
  const [sort, setSort] = useState<Sort>(initialSort);
  const isMobile = useIsMobile();

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.key === sort.key);
    const value = column?.sortValue;
    if (value === undefined) return rows;
    const sign = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign;
    });
  }, [rows, columns, sort]);

  const cycle = (key: string) =>
    setSort((current) =>
      current?.key !== key
        ? { key, direction: 'asc' }
        : current.direction === 'asc'
          ? { key, direction: 'desc' }
          : null,
    );

  if (rows.length === 0) return <Empty>{empty}</Empty>;

  return (
    <div className={className}>
      {!isMobile ? (
        <Table>
          {caption !== undefined && <caption className="sr-only">{caption}</caption>}
          <TableHeader>
            <TableRow>
              {columns.map((column) => {
                const active = sort?.key === column.key ? sort.direction : null;
                return (
                  <TableHead
                    key={column.key}
                    aria-sort={
                      active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined
                    }
                    className={cn(column.align === 'right' && 'text-right', column.className)}
                  >
                    {column.sortValue === undefined ? (
                      column.header
                    ) : (
                      <button
                        type="button"
                        onClick={() => cycle(column.key)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-sm hover:text-foreground',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        {active === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : active === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" aria-hidden />
                        )}
                      </button>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={getRowKey(row)}>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className={cn(
                      'whitespace-normal',
                      column.align === 'right' && 'text-right tabular-nums',
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <ul aria-label={caption}>
          {sorted.map((row) => (
            <li key={getRowKey(row)} className="border-b border-border px-4 py-3 last:border-b-0">
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                {columns.map((column) =>
                  column.hideLabelOnMobile === true ? (
                    <dd key={column.key} className="col-span-2 min-w-0 break-words">
                      {column.cell(row)}
                    </dd>
                  ) : (
                    <div key={column.key} className="contents">
                      <dt className="text-xs text-muted-foreground">{column.header}</dt>
                      <dd className="min-w-0 break-words">{column.cell(row)}</dd>
                    </div>
                  ),
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
