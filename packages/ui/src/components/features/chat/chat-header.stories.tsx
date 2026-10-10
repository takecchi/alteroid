import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChatHeader } from './chat-header';
import { ConversationDeletedNotice } from './conversation-deleted-notice';

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
    subtitle: '10/04 21:30 に開始 · 発言 8 件',
    onInterrupt: () => undefined,
    onEnd: () => undefined,
    onDelete: () => undefined,
  },
};

export const NewConversation: Story = { args: { conversationId: undefined } };

export const MobileWithNotice: Story = {
  args: {
    conversationId: 'conv_01J8ZK4Q3M7R2D9XW5T6YB0HNE',
    subtitle: '10/04 21:30 に開始 · 発言 8 件',
    onOpenList: () => undefined,
    onInterrupt: () => undefined,
    onEnd: () => undefined,
    notice: 'ターンを止めた。会話とセッションは残っている。',
  },
};

// 狭い画面で全部のボタンが並ぶ形。ヘッダーが縦に伸びないことを見る
export const MobileAllActions: Story = {
  args: {
    conversationId: 'conv_01J8ZK4Q3M7R2D9XW5T6YB0HNE',
    subtitle: '10/09 18:17 に開始 · 発言 2 件',
    onOpenList: () => undefined,
    onInterrupt: () => undefined,
    onEnd: () => undefined,
    onDelete: () => undefined,
  },
};

export const AfterDelete: Story = {
  args: {
    conversationId: undefined,
    notice: (
      <ConversationDeletedNotice
        result={{
          hiddenCount: 12,
          attachmentsRemoved: 2,
          commitmentsRemoved: 1,
          incomplete: ['受信箱の未処理の発言を外せなかった'],
          remainsIn: [
            'クローンの SDK セッションの生ログ',
            '蒸留済みの記憶・日報（本文は写していないが、要約として残りうる）',
          ],
        }}
      />
    ),
  },
};

export const MobileAfterEnd: Story = {
  args: {
    conversationId: undefined,
    onOpenList: () => undefined,
    notice:
      '会話を終えました。ここまでの学びを記憶にまとめます。終えた会話は左の一覧に残っていて、開けば続きを話せます。',
  },
};
