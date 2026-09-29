import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ApprovalCard } from './approval-card';

/** 承認待ちの1件。クローンが書いた問いだけ Markdown で描く。 */
const meta = {
  title: 'Features/Approvals/ApprovalCard',
  component: ApprovalCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  createdAt: '2026-09-29T20:06:00Z',
  createdLabel: '42 分前',
  jobLink: (
    <>
      {'job '}
      <a href="#" className="hover:underline">
        mgr-2b8e1c04
      </a>
    </>
  ),
  question: '本番の DB へ **migrate** を当ててよいか。',
  context:
    '`usage_daily_key_idx` を作り直す。当てているあいだ `/usage` が数秒遅くなる。\n\n- 戻すときは `down` を当てる\n- 夜の release/prod（UTC 19:17）より前に当てたい',
};

function Unanswered() {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  return (
    <>
      <ApprovalCard
        {...base}
        state="unanswered"
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={(text) => setSent(text)}
      />
      {sent !== null && <p className="mt-2 text-xs text-muted-foreground">送った: {sent}</p>}
    </>
  );
}

export const Default: Story = {
  args: { ...base, state: 'unanswered' },
  render: () => <Unanswered />,
};

export const Answered: Story = {
  args: {
    ...base,
    state: 'answered',
    answer: 'はい、進めてよい\n夜の release より前なら問題ない',
    answeredVia: 'Web UI（持ち主）',
  },
};

export const Withdrawn: Story = {
  args: {
    ...base,
    state: 'withdrawn',
    withdrawnReason: '別の手順で索引を作り直せたので、migrate は要らなくなった',
  },
};
