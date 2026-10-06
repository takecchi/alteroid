import type { Meta, StoryObj } from '@storybook/react-vite';

import { ApprovalCard } from '../approvals/approval-card';
import { ChatMessage, ChatMessageList } from './chat-message';

/**
 * 会話の中の承認のカード（#3259）。クローンが会話のターンで積んだ承認待ちを、
 * `createdAt` の位置に 1 件 1 枚で置く。回答・取り下げは同じカードの状態として出る。
 * 画面（`apps/web/app/routes/chat.tsx`）は `<li>` で包んで `ChatMessageList` に並べている。
 */
const meta = {
  title: 'Features/Chat/ApprovalInConversation',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const QUESTION = '本番の DB へ **migrate** を当ててよいか。';
const TIME = <span>09/29 20:06</span>;
const link = (
  <a href="#" className="mt-3 inline-block text-[11px] text-primary hover:underline">
    承認の画面で開く →
  </a>
);

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-3xl">
      <ChatMessageList>
        <ChatMessage role="human" text="migrate を当ててよいか、確認しておいて" />
        <ChatMessage role="clone" text="確認を承認待ちに積んだ。" />
        <li>{children}</li>
      </ChatMessageList>
    </div>
  );
}

/** 未回答。カードの中から答えられ、詳細の画面へも行ける。 */
export const Unanswered: Story = {
  render: () => (
    <Frame>
      <ApprovalCard
        state="unanswered"
        time={TIME}
        question={QUESTION}
        draft=""
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        trailing={link}
      />
    </Frame>
  ),
};

/** 回答済み。回答の時刻もカードの中に出る。後ろにクローンの返答が続く。 */
export const Answered: Story = {
  render: () => (
    <div className="max-w-3xl">
      <ChatMessageList>
        <ChatMessage role="human" text="migrate を当ててよいか、確認しておいて" />
        <li>
          <ApprovalCard
            state="answered"
            time={
              <>
                {TIME}
                <span>回答: 09/29 20:10</span>
              </>
            }
            question={QUESTION}
            answer="はい、進めてよい"
            answeredVia="Web UI（持ち主）"
            trailing={link}
          />
        </li>
        <ChatMessage role="clone" text="承知した。migrate を当てる。" />
      </ChatMessageList>
    </div>
  ),
};

/** 取り下げ。クローンが不要と判断した終端で、理由が出る。 */
export const Withdrawn: Story = {
  render: () => (
    <Frame>
      <ApprovalCard
        state="withdrawn"
        time={
          <>
            {TIME}
            <span>取り下げ: 09/29 20:12</span>
          </>
        }
        question={QUESTION}
        withdrawnReason="別の手順で索引を作り直せたので、migrate は要らなくなった"
        trailing={link}
      />
    </Frame>
  ),
};

/** 設問つき。要約 1 行と「選択肢を開いて答える」を出す。 */
export const WithQuestions: Story = {
  render: () => (
    <Frame>
      <ApprovalCard
        state="unanswered"
        time={TIME}
        question={QUESTION}
        questions={[
          {
            id: 'q1',
            prompt: 'どちらへ当てるか',
            options: [
              { id: 'o1', label: '本番', recommended: true },
              { id: 'o2', label: '検証' },
            ],
          },
        ]}
        questionsSummary="設問 1 件: どちらへ当てるか"
        onSubmitQuestions={() => undefined}
        trailing={link}
      />
    </Frame>
  ),
};
