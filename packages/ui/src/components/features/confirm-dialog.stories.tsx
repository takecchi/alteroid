import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '../common';

import { ConfirmDialog } from './confirm-dialog';

const meta = {
  title: 'Features/ConfirmDialog',
  component: ConfirmDialog,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo() {
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

export const Default: Story = {
  args: {
    open: false,
    onOpenChange: () => undefined,
    title: '',
    confirmLabel: '',
    onConfirm: () => undefined,
  },
  render: () => <Demo />,
};
