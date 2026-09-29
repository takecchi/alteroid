import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChatHeader } from './chat-header';

/** 会話の見出しの帯。「ターンを止める」はサーバ側のターンを止める。 */
const meta = {
  title: 'Features/Chat/ChatHeader',
  component: ChatHeader,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    conversationId: 'conv_01J8ZK4Q3M7R2D9XW5T6YB0HNE',
    onInterrupt: () => undefined,
    onEnd: () => undefined,
  },
};

export const NewConversation: Story = { args: { conversationId: undefined } };

/** 狭い画面（会話一覧を開く口つき）。ターンを止めた結果を1行で出す。 */
export const MobileWithNotice: Story = {
  args: {
    conversationId: 'conv_01J8ZK4Q3M7R2D9XW5T6YB0HNE',
    onOpenList: () => undefined,
    onInterrupt: () => undefined,
    onEnd: () => undefined,
    notice: 'ターンを止めた。会話とセッションは残っている。',
  },
};
