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
  sortValue?: (row: Row) => string | number | null;
  align?: 'left' | 'right';
  hideLabelOnMobile?: boolean;
  className?: string;
}

type Sort = { key: string; direction: 'asc' | 'desc' } | null;

// 並べ替えの値が無い行（`null`）は向きに関係なく末尾へ置く: 無い値を 0 や空文字として先頭に混ぜないため
// 狭い画面で表をやめて札にする: 列の多い表を横スクロールさせると、どの行を見ているかを見失うため
// どちらを描くかは `useIsMobile` で決める: CSS の `md:hidden` だと jsdom は CSS を評価せず、試験で両方が描かれて見えるため
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
