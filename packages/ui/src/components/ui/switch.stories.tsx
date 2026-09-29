import type { Meta, StoryObj } from '@storybook/react-vite';

import { Switch } from './switch';
import { Label } from './label';

const meta = {
  title: 'shadcn/Switch',
  component: Switch,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="autonomy" defaultChecked />
      <Label htmlFor="autonomy">自律を許可する</Label>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Switch size="sm" defaultChecked />
      <Switch size="default" defaultChecked />
    </div>
  ),
};
