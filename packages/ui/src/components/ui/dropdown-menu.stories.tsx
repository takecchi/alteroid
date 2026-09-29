import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from './dropdown-menu';
import { Button } from './button';

const meta = {
  title: 'shadcn/DropdownMenu',
  component: DropdownMenu,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">メニューを開く</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>マネージャー</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>編集する</DropdownMenuItem>
        <DropdownMenuItem>複製する</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>通知する</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">削除する</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
