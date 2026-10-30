import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { Card } from '../../common';

import { JournalEntryRow } from './journal-entry-row';

const meta = {
  title: 'Features/Journal/JournalEntryRow',
  component: JournalEntryRow,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <Card className="max-w-3xl">
        <Story />
      </Card>
    ),
  ],
} satisfies Meta<typeof JournalEntryRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const decision = {
  type: 'decision',
  at: '2026-09-29T20:45:12Z',
  summary: 'SDK の更新 PR は CI が緑なので自分の判断でマージする（#1053 の決定）',
  managerId: 'mgr-9d4f6a17',
};

export const Decision: Story = {
  args: {
    atLabel: '09-30 05:45',
    time: '3 分前',
    type: 'decision',
    tone: 'accent',
    summary: decision.summary,
    raw: decision,
  },
};

// 行を開く操作（要旨の左のボタンを押す）で開いた状態を見せる
async function openRow({ canvasElement }: { canvasElement: HTMLElement }) {
  await userEvent.click(within(canvasElement).getByRole('button', { expanded: false }));
}

export const Open: Story = {
  args: {
    ...Decision.args,
    links: (
      <p className="text-xs">
        <a href="#" className="font-mono text-primary hover:underline">
          mgr-9d4f6a17
        </a>
      </p>
    ),
  } as Story['args'],
  play: openRow,
};

export const List: Story = {
  args: Decision.args,
  render: () => (
    <>
      <JournalEntryRow
        atLabel="09-30 05:47"
        time="1 分前"
        type="escalation"
        tone="warn"
        summary="確認したいことがある: 社外に出す資料に実測の費用を載せてよいか"
        raw={{ type: 'escalation' }}
      />
      <JournalEntryRow {...(Decision.args as Required<typeof Decision>['args'])} />
      <JournalEntryRow
        atLabel="09-30 05:30"
        time="18 分前"
        type="memory_update"
        tone="ok"
        summary="「社外の資料には費用の実測を載せない」を価値観へ足した"
        raw={{ type: 'memory_update' }}
        isLast
      />
    </>
  ),
};

export const PlainTimeWithoutRawBar: Story = {
  args: {
    ...Decision.args,
    rawBar: false,
  },
  play: openRow,
};
