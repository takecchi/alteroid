import type { Meta, StoryObj } from '@storybook/react-vite';

import { StackedBar } from './stacked-bar';

const meta = {
  title: 'Features/Charts/StackedBar',
  component: StackedBar,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StackedBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Appraisal: Story = {
  args: {
    formatValue: (value) => `${value} 件`,
    segments: [
      { key: 'good', label: '良かった', value: 8, tone: 'ok' },
      { key: 'bad', label: '良くなかった', value: 2, tone: 'danger' },
      { key: 'unclear', label: '判断できない', value: 2, tone: 'neutral' },
    ],
  },
};

export const Layers: Story = {
  args: {
    formatValue: (value) => `$${value.toFixed(2)}`,
    segments: [
      { key: 'clone', label: 'クローン', value: 1.02, tone: 'chart-1' },
      { key: 'manager', label: 'マネージャー', value: 2.64, tone: 'chart-2' },
      { key: 'worker', label: '作業者', value: 0.52, tone: 'chart-3' },
      { key: 'other', label: 'その他', value: 0.1, tone: 'other' },
    ],
  },
};

export const Empty: Story = {
  args: {
    segments: [
      { key: 'good', label: '良かった', value: 0, tone: 'ok' },
      { key: 'bad', label: '良くなかった', value: 0, tone: 'danger' },
    ],
    emptyText: 'まだ評定が無い。',
  },
};
