import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusDot } from './status-dot';

/** 札より静かに状態を言う。文言が本体で、点は添え物。 */
const meta = {
  title: 'Features/StatusDot',
  component: StatusDot,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { tone: 'accent', children: '実行中' } };

export const All: Story = {
  args: { children: '' },
  render: () => (
    <div className="flex flex-wrap gap-6">
      <StatusDot tone="ok">完了</StatusDot>
      <StatusDot tone="accent">実行中</StatusDot>
      <StatusDot tone="warn">承認待ち</StatusDot>
      <StatusDot tone="danger">失敗</StatusDot>
      <StatusDot>待機</StatusDot>
    </div>
  ),
};
