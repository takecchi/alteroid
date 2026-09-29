import { Line, LineChart } from 'recharts';

import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

const config = { value: { label: '値', color: 'var(--chart-1)' } } satisfies ChartConfig;

/**
 * 量の横に添える小さな推移の線（`Stat` の下など）。軸も目盛りも持たない。
 *
 * **形を見るためのもので、値を読むためのものではない。** 値は隣の数字が持つ。
 * だから読み上げからは外す。記録の無い点（`null`）は線を途切れさせる
 * （0 へ落とさない）。
 */
export function Sparkline({
  values,
  className,
}: {
  values: readonly (number | null)[];
  className?: string;
}) {
  const data = values.map((value, index) => ({ index, value }));
  return (
    <div aria-hidden className={cn('h-8 w-24', className)}>
      <ChartContainer config={config} className="aspect-auto size-full">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            dataKey="value"
            type="monotone"
            stroke="var(--color-value)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
}
