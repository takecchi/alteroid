import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from './common';
import { Drawer } from './drawer';

/** 狭い画面で脇の面を覆いかぶせて出す（`drawer.tsx`）。 */
const meta = {
  title: 'Layout/Drawer',
  component: Drawer,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>メニューを開く</Button>
      <Drawer open={open} onClose={() => setOpen(false)} label="メニュー">
        <p className="p-4 text-sm">脇の面の中身（画面では行き先の一覧・会話の一覧）</p>
      </Drawer>
    </>
  );
}

export const Default: Story = {
  args: { open: false, onClose: () => undefined, label: 'メニュー', children: null },
  render: () => <Demo />,
};
