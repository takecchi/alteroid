import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../common';

import { Toaster, toast } from './toaster';

/** 操作の結果を短く知らせる。失敗はトーストだけで言わない（画面に残す）。 */
const meta = {
  title: 'Features/Toaster',
  component: Toaster,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Toaster />
      <Button variant="primary" onClick={() => toast.success('承認した')}>
        承認する
      </Button>
      <Button
        onClick={() => toast('下書きを保存した', { description: '送るまでは画面にだけ残る' })}
      >
        下書きを保存する
      </Button>
    </div>
  ),
};
