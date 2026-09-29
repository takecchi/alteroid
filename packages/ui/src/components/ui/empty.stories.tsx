import type { Meta, StoryObj } from '@storybook/react-vite';
import { InboxIcon } from 'lucide-react';

import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from './empty';
import { Button } from './button';

const meta = {
  title: 'UI/Empty',
  component: Empty,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Empty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Empty className="w-96 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InboxIcon />
        </EmptyMedia>
        <EmptyTitle>まだ日誌がありません</EmptyTitle>
        <EmptyDescription>マネージャーが仕事を始めるとここに表示されます。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm">仕事を依頼する</Button>
      </EmptyContent>
    </Empty>
  ),
};
