import type { Meta, StoryObj } from '@storybook/react-vite';

import { AnsweredApprovalRow } from './answered-approval-row';

/**
 * 回答済みの画面の、日ごとの一覧の1行。行全体が1つのリンク（見本ではただの `<a>`）。
 * 回答済と取り下げ済で札の色が違う。本文は各 2 行で切る。
 */
const meta = {
  title: 'Features/Approvals/AnsweredApprovalRow',
  component: AnsweredApprovalRow,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    time: '2026/09/30 14:05',
    question: '本番の DB へ migrate を当ててよいか。',
    renderLink: ({ className, children }) => (
      <a href="#answered" className={className}>
        {children}
      </a>
    ),
  },
} satisfies Meta<typeof AnsweredApprovalRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Answered: Story = {
  args: { state: 'answered', answer: '夜の release より前なら当ててよい。' },
};

export const Withdrawn: Story = {
  args: { state: 'withdrawn', withdrawnReason: '自分で答えを見つけた' },
};

/** 長い問いと答えは各 2 行で切る。全文は詳細で読む。 */
export const LongText: Story = {
  args: {
    state: 'answered',
    question:
      '`usage_daily_key_idx` を作り直す。当てているあいだ /usage が数秒遅くなる。戻すときは down を当てる。夜の release（UTC 19:17）より前に当てたいが、いまは他の migrate が走っていて待つ必要があるかもしれない。どうするか。',
    answer:
      '待たずに当ててよい。ただし他の migrate が終わっていることを確かめてから。終わっていなければ、その migrate が終わるのを待って、終わったら当てる。夜の release に間に合わなければ翌朝でよい。',
  },
};

/** 答えも理由も無い行（古い記録・理由を書かずに取り下げた件）。 */
export const Minimal: Story = {
  args: { state: 'withdrawn' },
};
