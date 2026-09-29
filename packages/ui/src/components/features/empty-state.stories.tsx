import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox } from 'lucide-react';

import { Button, Card } from '../common';

import { EmptyState } from './empty-state';

/** 空は「次に何をすればよいか」を言う場所。 */
const meta = {
  title: 'Features/EmptyState',
  component: EmptyState,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <Card className="max-w-xl">
        <Story />
      </Card>
    ),
  ],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: Inbox,
    title: '受信箱は空',
    description: '外部イベント（POST /events）が届くと、クローンが読むまでここに残る。',
    action: <Button size="sm">イベントの送り方を見る</Button>,
  },
};
