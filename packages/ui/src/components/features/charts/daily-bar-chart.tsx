import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

export interface DailyBarDatum {
  /** 表示用の日付（`09-30` など。整形は呼ぶ側）。 */
  label: string;
  /**
   * その日の値。**記録が無い日は `null`**（0 ではない）。
   *
   * 「$0 だった日」と「記録が無い日」は別物である。無い日を 0 の棒で描くと
   * 「使っていない」と読めてしまう（AGENTS.md の地雷「取れない軸に 0 の行を作る」）。
   * `null` の日は破線の短い印（高さは値ではない）で描き、ツールチップで
   * 「記録なし」と言う。
   */
  value: number | null;
}

const config = {
  value: { label: '値', color: 'var(--chart-1)' },
  missing: { label: '記録なし', color: 'var(--muted-foreground)' },
} satisfies ChartConfig;

/** 記録の無い日の印の高さ（最大値に対する割合）。値ではないので小さく、固定。 */
const MISSING_MARK_RATIO = 0.04;

/**
 * 日ごとの量（費用・ターン数）の棒グラフ。1系列なので凡例は出さない（見出しが名前）。
 *
 * - 棒は 24px を上限に細く、先端だけ 4px 丸める（根元は角のまま）
 * - 格子は横線だけ、1px の実線で控えめに
 * - 指を載せると、その日の値（無ければ「記録なし」）を出す
 * - 数字の目盛りは `formatValue` で整形する（`$1.20` など）
 *
 * 表で読みたい人のために、同じ値は呼ぶ側が一覧（`BarList` など）でも出すこと —
 * グラフだけにすると、ツールチップに指を載せない人には値が読めない。
 */
export function DailyBarChart({
  data,
  formatValue = (value) => String(value),
  className,
}: {
  data: readonly DailyBarDatum[];
  formatValue?: (value: number) => string;
  className?: string;
}) {
  const max = Math.max(0, ...data.map((d) => d.value ?? 0));
  const missingHeight = max > 0 ? max * MISSING_MARK_RATIO : 1;
  const rows = data.map((d) => ({
    label: d.label,
    value: d.value,
    missing: d.value === null ? missingHeight : null,
  }));

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-56 w-full', className)}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(value: number) => formatValue(value)}
        />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as (typeof rows)[number] | undefined;
            if (active !== true || row === undefined) return null;
            return (
              <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                <p className="text-muted-foreground">{row.label}</p>
                <p className="mt-0.5 font-medium tabular-nums">
                  {row.value === null ? '記録なし' : formatValue(row.value)}
                </p>
              </div>
            );
          }}
        />
        <Bar
          dataKey="value"
          stackId="day"
          fill="var(--color-value)"
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
          isAnimationActive={false}
        />
        <Bar
          dataKey="missing"
          stackId="day"
          maxBarSize={24}
          isAnimationActive={false}
          shape={(props: unknown) => (
            <Rectangle
              {...(props as object)}
              fill="none"
              stroke="var(--color-missing)"
              strokeDasharray="3 2"
              strokeWidth={1}
            />
          )}
        />
      </BarChart>
    </ChartContainer>
  );
}
