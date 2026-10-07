import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card, CardHeader } from '../../common';

import { BarList } from './bar-list';

/** 割合の帯つきの一覧。最大の行に対する長さの帯を敷く。 */
const meta = {
  title: 'Features/Charts/BarList',
  component: BarList,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <Card className="max-w-md">
        <CardHeader title="モデル別" />
        <Story />
      </Card>
    ),
  ],
} satisfies Meta<typeof BarList>;

export default meta;
type Story = StoryObj<typeof meta>;

const usd = (value: number) => `$${value.toFixed(2)}`;

export const Default: Story = {
  args: {
    formatValue: usd,
    items: [
      { label: 'opus', value: 2.64 },
      { label: 'fable', value: 1.02 },
      { label: 'sonnet', value: 0.52 },
      { label: 'haiku', value: 0.03 },
    ],
  },
};

/** 上限で切ったとき。切ったことを但し書きで言う。 */
export const Truncated: Story = {
  args: {
    formatValue: usd,
    limit: 3,
    items: [
      { label: 'mgr-7f3c2a91', value: 1.92 },
      { label: 'mgr-2b8e1c04', value: 0.88 },
      { label: 'mgr-9d4f6a17', value: 0.41 },
      { label: 'mgr-0c1e7b55', value: 0.2 },
      { label: 'mgr-5a3d9e82', value: 0.07 },
    ],
  },
};

/** 表示名が重なる行。`id` を渡すと key が重ならない（表示名に印を添えるのは呼ぶ側）。 */
export const DuplicateLabels: Story = {
  args: {
    formatValue: usd,
    items: [
      { id: 'mgr-7f3c2a91', label: '（一覧に無い委譲）（mgr-7f3c）', value: 1.2 },
      { id: 'mgr-2b8e1c04', label: '（一覧に無い委譲）（mgr-2b8e）', value: 0.4 },
    ],
  },
};

export const Empty: Story = { args: { items: [] } };
