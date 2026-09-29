import type { Meta, StoryObj } from '@storybook/react-vite';

import { Label } from './label';
import { Input } from './input';

const meta = {
  title: 'shadcn/Label',
  component: Label,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: '表示名' },
};

export const WithInput: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="display-name">表示名</Label>
      <Input id="display-name" placeholder="マネージャー" className="w-64" />
    </div>
  ),
};
