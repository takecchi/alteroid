import type { Meta, StoryObj } from '@storybook/react-vite';
import { BoldIcon } from 'lucide-react';

import { Toggle } from './toggle';

const meta = {
  title: 'UI/Toggle',
  component: Toggle,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'select', options: ['default', 'outline'] },
    size: { control: 'select', options: ['default', 'sm', 'lg'] },
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: '太字', 'aria-label': '太字' },
};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle aria-label="太字">
        <BoldIcon />
      </Toggle>
      <Toggle variant="outline" aria-label="太字">
        <BoldIcon />
      </Toggle>
      <Toggle defaultPressed aria-label="太字">
        押下中
      </Toggle>
    </div>
  ),
};
