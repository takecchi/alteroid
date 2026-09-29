import type { Meta, StoryObj } from '@storybook/react-vite';

import { Progress } from './progress';

const meta = {
  title: 'shadcn/Progress',
  component: Progress,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100, step: 1 } },
  },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: 40, className: 'w-64' },
};

export const Levels: Story = {
  render: () => (
    <div className="flex w-64 flex-col gap-3">
      <Progress value={10} />
      <Progress value={50} />
      <Progress value={90} />
    </div>
  ),
};
