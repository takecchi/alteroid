import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card, CardHeader } from '../../common';

import { DailyBarChart, type DailyBarDatum } from './daily-bar-chart';

/** 日ごとの量。記録の無い日（`null`）は 0 の棒にせず、破線の短い印で描く。 */
const meta = {
  title: 'Features/Charts/DailyBarChart',
  component: DailyBarChart,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <Card className="max-w-3xl">
        <CardHeader title="日別の費用" subtitle="直近 14 日（JST）" />
        <div className="p-4">
          <Story />
        </div>
      </Card>
    ),
  ],
} satisfies Meta<typeof DailyBarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

const COSTS = [3.2, 4.8, 2.1, null, 0, 6.4, 5.9, 4.1, 7.8, 3.3, null, 2.7, 5.2, 4.18];
const data: DailyBarDatum[] = COSTS.map((value, index) => ({
  label: `09-${String(17 + index).padStart(2, '0')}`,
  value,
}));
const usd = (value: number) => `$${value.toFixed(2)}`;

export const Default: Story = { args: { data, formatValue: usd } };

/** まだ何も記録されていない（全部 `null`）。 */
export const NoRecords: Story = {
  args: { data: data.map((d) => ({ ...d, value: null })), formatValue: usd },
};
