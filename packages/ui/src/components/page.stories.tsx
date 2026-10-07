import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button, Card, CardHeader, Empty } from './common';
import { Page } from './page';

const meta = {
  title: 'Layout/Page',
  component: Page,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="h-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: '未了の仕事',
    description: 'クローンが引き受けて、まだ片付いていないもの',
    action: <Button size="sm">絞り込む</Button>,
    children: (
      <Card>
        <CardHeader title="今週" subtitle="3 件" />
        <Empty>ここに一覧が並ぶ。</Empty>
      </Card>
    ),
  },
};
