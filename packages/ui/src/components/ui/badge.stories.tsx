import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge } from './badge';

const meta = {
  title: 'shadcn/Badge',
  component: Badge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: '実行中', variant: 'default' },
};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>既定</Badge>
      <Badge variant="secondary">補助</Badge>
      <Badge variant="destructive">停止</Badge>
      <Badge variant="outline">下書き</Badge>
      <Badge variant="ghost">控えめ</Badge>
      <Badge variant="link">詳細</Badge>
    </div>
  ),
};
