import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card, CardHeader } from '../common';

import { Stat } from './stat';

/** 1つの量。数字は本文の書体（IBM Plex Sans JP）の等幅数字（tabular-nums）で出す。0 と O を見分けられる。 */
const meta = {
  title: 'Features/Stat',
  component: Stat,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Stat>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: '今日の費用', value: '$4.18', hint: '上限 $20.00' },
};

export const Warn: Story = {
  args: {
    label: '承認待ち',
    value: '3',
    unit: '件',
    tone: 'warn',
    hint: 'いちばん古いのは 42 分前',
  },
};

/** 取れない量に 0 を出さない。値を作らず、取れない理由を書く。 */
export const Unavailable: Story = {
  args: { label: '作業者の費用', value: '—', hint: '台帳に site が無いので取れない' },
};

export const Row: Story = {
  args: { label: '', value: '' },
  render: () => (
    <Card className="max-w-3xl">
      <CardHeader title="今日" subtitle="2026-09-30（JST）" />
      <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-4">
        <Stat label="費用" value="$4.18" hint="上限 $20.00" />
        <Stat label="承認待ち" value="3" unit="件" tone="warn" />
        <Stat label="完了した委譲" value="12" unit="件" tone="ok" />
        <Stat label="作業者の費用" value="—" hint="台帳に site が無いので取れない" />
      </div>
    </Card>
  ),
};
