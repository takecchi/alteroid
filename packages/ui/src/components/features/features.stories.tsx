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

import { CommandMenu } from './command-menu';
import { ConfirmDialog } from './confirm-dialog';

/** 振る舞いを持つまとまり（`components/features/`）。 */
const meta = {
  title: 'App/Features',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ConfirmDemo() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <Button variant="danger" onClick={() => setOpen(true)}>
        既読を一括削除する
      </Button>
      {result !== null && <p className="text-xs text-muted-foreground">{result}</p>}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        destructive
        title="既読の 48 件を削除する"
        description="受信箱から消える。日誌に残った「読んだ」記録は消えない。未読の 3 件は残る。"
        confirmLabel="削除する"
        onConfirm={() => setResult('削除した（見本なので実際には何も消えていない）')}
      />
    </div>
  );
}

export const Confirm: Story = { render: () => <ConfirmDemo /> };

function CommandDemo() {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <Button onClick={() => setOpen(true)}>
        行き先を探す <Kbd>⌘K</Kbd>
      </Button>
      {picked !== null && <p className="font-mono text-xs text-muted-foreground">{picked}</p>}
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        onSelect={setPicked}
        groups={[
          {
            heading: '行き先',
            items: [
              { value: '/', label: 'ダッシュボード', icon: LayoutDashboard },
              { value: '/chat', label: '会話', icon: MessageSquare },
              { value: '/approvals', label: '承認待ち', icon: BellRing },
              { value: '/managers', label: 'マネージャー', icon: Users },
              { value: '/journal', label: '日誌', icon: Activity },
              {
                value: '/usage',
                label: '利用状況',
                icon: DollarSign,
                keywords: ['費用', 'コスト'],
              },
              { value: '/tokens', label: '認証トークン', icon: KeyRound },
              { value: '/memory', label: '記憶', icon: Brain },
            ],
          },
          {
            heading: '操作',
            items: [{ value: 'new-chat', label: '新しい会話を始める', icon: Plus }],
          },
        ]}
      />
    </div>
  );
}

export const Command: Story = { render: () => <CommandDemo /> };
