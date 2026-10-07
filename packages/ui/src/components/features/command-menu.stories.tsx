import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Activity,
  BellRing,
  Brain,
  DollarSign,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Users,
} from 'lucide-react';
import { useState } from 'react';

import { Kbd } from '@/components/ui/kbd';

import { Button } from '../common';

import { CommandMenu, type CommandMenuGroup } from './command-menu';

const meta = {
  title: 'Features/CommandMenu',
  component: CommandMenu,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof CommandMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const GROUPS: CommandMenuGroup[] = [
  {
    heading: '行き先',
    items: [
      { value: '/', label: 'ダッシュボード', icon: LayoutDashboard },
      { value: '/chat', label: '会話', icon: MessageSquare },
      { value: '/approvals', label: '承認待ち', icon: BellRing },
      { value: '/managers', label: 'マネージャー', icon: Users },
      { value: '/journal', label: '日誌', icon: Activity },
      { value: '/usage', label: '利用状況', icon: DollarSign, keywords: ['費用', 'コスト'] },
      { value: '/tokens', label: '認証トークン', icon: KeyRound },
      { value: '/memory', label: '記憶', icon: Brain },
    ],
  },
  { heading: '操作', items: [{ value: 'new-chat', label: '新しい会話を始める', icon: Plus }] },
];

function Demo() {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <Button onClick={() => setOpen(true)}>
        行き先を探す <Kbd>⌘K</Kbd>
      </Button>
      {picked !== null && <p className="font-mono text-xs text-muted-foreground">{picked}</p>}
      <CommandMenu open={open} onOpenChange={setOpen} onSelect={setPicked} groups={GROUPS} />
    </div>
  );
}

export const Default: Story = {
  args: { open: true, onOpenChange: () => undefined, onSelect: () => undefined, groups: GROUPS },
  render: () => <Demo />,
};
