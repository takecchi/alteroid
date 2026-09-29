import type { Meta, StoryObj } from '@storybook/react-vite';

import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';

const meta = {
  title: 'UI/HoverCard',
  component: HoverCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        <a href="#" className="font-mono text-sm text-primary underline-offset-4 hover:underline">
          mgr-7f3c2a91
        </a>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-xs">
        <p className="font-medium">apps/web の見た目を差し替える</p>
        <p className="mt-1 text-muted-foreground">実行中・開始 02:14（JST 11:14）・$1.92</p>
      </HoverCardContent>
    </HoverCard>
  ),
};
