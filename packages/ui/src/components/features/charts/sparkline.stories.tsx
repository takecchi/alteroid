import type { Meta, StoryObj } from '@storybook/react-vite';

import { Stat } from '../stat';

import { Sparkline } from './sparkline';

const meta = {
  title: 'Features/Charts/Sparkline',
  component: Sparkline,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Sparkline>;

export default meta;
type Story = StoryObj<typeof meta>;

const values = [3.2, 4.8, 2.1, null, 0, 6.4, 5.9, 4.1, 7.8, 3.3, 2.7, 5.2, 4.18];

export const Default: Story = { args: { values } };

export const WithStat: Story = {
  args: { values },
  render: (args) => (
    <div className="flex items-end gap-4">
      <Stat label="今日の費用" value="$4.18" hint="直近 13 日の推移" />
      <Sparkline {...args} />
    </div>
  ),
};
