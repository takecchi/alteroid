import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { FilterChips } from './filter-chips';

/** 絞り込みのチップ。何も選んでいない＝全部。 */
const meta = {
  title: 'Features/FilterChips',
  component: FilterChips,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof FilterChips>;

export default meta;
type Story = StoryObj<typeof meta>;

const TYPES = [
  'exchange',
  'decision',
  'escalation',
  'tool_use',
  'memory_update',
  'daily_report',
  'external_event',
  'token_rotation',
] as const;

function Demo() {
  const [selected, setSelected] = useState<(typeof TYPES)[number][]>(['decision']);
  return (
    <div className="max-w-2xl space-y-3">
      <FilterChips
        label="種別で絞り込む"
        options={TYPES.map((value) => ({ value }))}
        selected={selected}
        onChange={setSelected}
      />
      <p className="font-mono text-xs text-muted-foreground">
        {selected.length === 0 ? '全部' : selected.join(',')}
      </p>
    </div>
  );
}

export const Default: Story = {
  args: { label: '', options: [], selected: [], onChange: () => undefined },
  render: () => <Demo />,
};

/** 件数つき（分かるときだけ）。 */
export const WithCounts: Story = {
  args: {
    label: '状態で絞り込む',
    selected: ['running'],
    onChange: () => undefined,
    options: [
      { value: 'running', label: '実行中', count: 2 },
      { value: 'waiting_human', label: '人間待ち', count: 1 },
      { value: 'done', label: '待機中', count: 14 },
      { value: 'failed', label: '失敗', count: 1 },
    ],
  },
};
