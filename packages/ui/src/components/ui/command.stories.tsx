import type { Meta, StoryObj } from '@storybook/react-vite';
import { Activity, BellRing, LayoutDashboard, Settings } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './command';

const meta = {
  title: 'UI/Command',
  component: Command,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Command className="w-80 border border-border">
      <CommandInput placeholder="行き先や操作の名前を打つ" />
      <CommandList>
        <CommandEmpty>当てはまるものが無い</CommandEmpty>
        <CommandGroup heading="行き先">
          <CommandItem>
            <LayoutDashboard />
            ダッシュボード
          </CommandItem>
          <CommandItem>
            <BellRing />
            承認待ち
          </CommandItem>
          <CommandItem>
            <Activity />
            日誌
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="操作">
          <CommandItem>
            <Settings />
            設定を開く
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};
