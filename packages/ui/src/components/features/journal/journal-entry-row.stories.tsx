import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from '../../common';

import { JournalEntryRow } from './journal-entry-row';

/** 日誌の1件。押すと生の中身まで降りられる。 */
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
    at: decision.at,
    atLabel: '09-30 05:45',
    relativeLabel: '3 分前',
    type: 'decision',
    tone: 'accent',
    summary: decision.summary,
    raw: decision,
  },
};

export const Open: Story = {
  args: {
    ...Decision.args,
    defaultOpen: true,
    links: (
      <p className="text-xs">
        <a href="#" className="font-mono text-primary hover:underline">
          mgr-9d4f6a17
        </a>
      </p>
    ),
  } as Story['args'],
};

export const List: Story = {
  args: Decision.args,
  render: () => (
    <>
      <JournalEntryRow
        at="2026-09-29T20:47:00Z"
        atLabel="09-30 05:47"
        relativeLabel="1 分前"
        type="escalation"
        tone="warn"
        summary="確認したいことがある: 社外に出す資料に実測の費用を載せてよいか"
        raw={{ type: 'escalation' }}
      />
      <JournalEntryRow {...(Decision.args as Required<typeof Decision>['args'])} />
      <JournalEntryRow
        at="2026-09-29T20:30:00Z"
        atLabel="09-30 05:30"
        relativeLabel="18 分前"
        type="memory_update"
        tone="ok"
        summary="「社外の資料には費用の実測を載せない」を価値観へ足した"
        raw={{ type: 'memory_update' }}
        isLast
      />
    </>
  ),
};
