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

/** 時刻の位置に画面が用意した表示を差し込む口（`time`）。渡すと `Timestamp` は出ない。 */
export const CustomTime: Story = {
  args: {
    ...base,
    state: 'unanswered',
    time: (
      <>
        <span>2026/09/30 05:06</span>
        <span>(42 分前)</span>
      </>
    ),
  },
};

/** `error`（回答欄の下）と `trailing`（そのさらに下。画面では会話のパネル）。 */
export const WithErrorAndTrailing: Story = {
  args: {
    ...base,
    state: 'unanswered',
    error: <p className="text-sm text-destructive">送れなかった: 通信に失敗した</p>,
    trailing: (
      <div className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
        この確認が上がった会話（画面が差し込む）
      </div>
    ),
  },
};

/** 設問つき（`questions`）。閉じていると要約1行だけで、開くと選択肢を押して「回答」で一括送信する。 */
export const WithQuestions: Story = {
  args: {
    ...base,
    state: 'unanswered',
    questions: [
      {
        id: 'deploy',
        prompt: 'デプロイ先',
        options: [
          { id: 'railway', label: 'Railway', description: '今の本番と同じ', recommended: true },
          { id: 'fly', label: 'Fly.io' },
        ],
      },
      {
        id: 'notify',
        prompt: '通知先',
        multiple: true,
        options: [
          { id: 'slack', label: 'Slack' },
          { id: 'mail', label: 'メール' },
        ],
      },
    ],
    onSubmitQuestions: () => undefined,
  },
};
