import type { Meta, StoryObj } from '@storybook/react-vite';

import { Meter } from './meter';

const meta = {
  title: 'Features/Charts/Meter',
  component: Meter,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Meter>;

export default meta;
type Story = StoryObj<typeof meta>;

const usd = (value: number) => `$${value.toFixed(2)}`;

export const Default: Story = {
  args: {
    label: '今日の費用',
    value: 4.18,
    max: 20,
    formatValue: usd,
    hint: '日報の締めまで 6 時間',
  },
};
export const Warn: Story = {
  args: { label: '今日の費用', value: 17.4, max: 20, formatValue: usd },
};
export const Over: Story = {
  args: { label: '今日の費用', value: 23.1, max: 20, formatValue: usd },
};
export const Unavailable: Story = {
  args: {
    label: '5 時間枠の消費',
    value: null,
    max: 100,
    unavailable: 'このトークンは枠の残りを返さない（account_probe が未対応）',
  },
};
