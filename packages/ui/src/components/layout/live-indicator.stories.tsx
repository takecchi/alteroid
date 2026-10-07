import type { Meta, StoryObj } from '@storybook/react-vite';

import { LiveIndicator } from './live-indicator';

const meta = {
  title: 'Layout/LiveIndicator',
  component: LiveIndicator,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof LiveIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = { args: { status: 'live' } };
export const Connecting: Story = { args: { status: 'connecting' } };
export const Offline: Story = { args: { status: 'offline' } };
