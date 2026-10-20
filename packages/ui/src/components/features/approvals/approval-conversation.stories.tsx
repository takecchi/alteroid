import type { Meta, StoryObj } from '@storybook/react-vite';

import { ApprovalConversation } from './approval-conversation';
import { LONG_CONVERSATION } from './approval-conversation-samples';

const meta = {
  title: 'Features/Approvals/ApprovalConversation',
  component: ApprovalConversation,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-md border border-border bg-card p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalConversation>;

export default meta;
type Story = StoryObj<typeof meta>;

const footer = (
  <a href="#" className="mt-2 inline-block text-[11px] text-primary hover:underline">
    この会話をチャットで開く →
  </a>
);

/** 長い会話。既定は直近の3件だけで、長い発言は頭だけを出す。 */
export const LongConversation: Story = {
  args: { messages: LONG_CONVERSATION, reachedStart: false, footer },
};

/** 3件以下なら畳む操作を出さない。 */
export const ShortConversation: Story = {
  args: {
    messages: [
      { id: 'm1', role: 'inbound', text: '本番に出してよいか確認して' },
      { id: 'm2', role: 'outbound', text: '確認を上げた。答えが来たら進める' },
    ],
    reachedStart: true,
    footer,
  },
};

/** 添付の名前は本文の下に1行で添える。 */
export const WithAttachmentNote: Story = {
  args: {
    messages: [
      {
        id: 'm1',
        role: 'inbound',
        text: 'このログを見て',
        note: '［添付 2件: a.png、b.log］',
      },
      { id: 'm2', role: 'outbound', text: '読んだ。migrate の失敗だった' },
    ],
    reachedStart: true,
    footer,
  },
};
