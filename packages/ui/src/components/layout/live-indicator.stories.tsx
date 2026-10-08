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
export const WithConnection: Story = {
  args: {
    status: 'live',
    connection: { name: '自宅', title: '自宅 — https://home.example.com:8787' },
  },
};
export const LongConnectionName: Story = {
  args: {
    status: 'live',
    connection: {
      name: 'とても長い名前を付けた検証用のデーモン（家の NAS の中のコンテナ）',
      title:
        'とても長い名前を付けた検証用のデーモン（家の NAS の中のコンテナ） — https://nas.example.com',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-48">
        <Story />
      </div>
    ),
  ],
};
