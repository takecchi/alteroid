import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip';
import { Button } from './button';

const meta = {
  title: 'shadcn/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <Button variant="outline">保存する</Button>
      </TooltipTrigger>
      <TooltipContent>変更を保存します</TooltipContent>
    </Tooltip>
  ),
};
