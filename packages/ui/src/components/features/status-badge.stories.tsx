import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusBadge, type StatusMap } from './status-badge';

/** 状態の札。知らない状態は生の値のまま出す（落ちない）。 */
const meta = {
  title: 'Features/StatusBadge',
  component: StatusBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 画面（`managers.tsx`）の対応を写した見本。正本は画面の側。 */
const MANAGER: StatusMap<'running' | 'waiting_human' | 'done' | 'failed'> = {
  running: { tone: 'ok', label: '実行中' },
  waiting_human: { tone: 'warn', label: '人間待ち' },
  done: { tone: 'neutral', label: '待機中' },
  failed: { tone: 'danger', label: '失敗' },
};

export const All: Story = {
  args: { status: 'running', map: MANAGER },
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(['running', 'waiting_human', 'done', 'failed', 'resuming_v2'] as const).map((status) => (
        <StatusBadge key={status} status={status} map={MANAGER} />
      ))}
    </div>
  ),
};
