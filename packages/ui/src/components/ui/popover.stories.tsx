import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from './popover';
import { Button } from './button';

const meta = {
  title: 'shadcn/Popover',
  component: Popover,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">詳細を見る</Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>実行状況</PopoverTitle>
          <PopoverDescription>マネージャーは現在待機中です。</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  ),
};
