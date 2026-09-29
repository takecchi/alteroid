import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ChatMessage, ChatMessageList } from './chat-message';
import { ChatMessageEditor } from './chat-message-editor';

/** やりとりの1行。クローンの本文だけ Markdown で描く。 */
const meta = {
  title: 'Features/Chat/ChatMessage',
  component: ChatMessage,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <ChatMessageList>
          <Story />
        </ChatMessageList>
      </div>
    ),
  ],
} satisfies Meta<typeof ChatMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Human: Story = {
  args: {
    role: 'human',
    text: '来週の登壇資料、構成案だけ先に作っておいて。*強調* は打ったまま見える。',
    onEdit: () => undefined,
  },
};

export const Clone: Story = {
  args: {
    role: 'clone',
    text: '構成案をマネージャーに頼んだ。**3部構成**で考えている:\n\n1. 背景（なぜクローンか）\n2. 設計（層とモデル帯）\n3. 運用で踏んだ地雷\n\n`mgr-7f3c` が下調べを進めている。',
  },
};

/** 最初のチャンクがまだ届いていない。 */
export const CloneWaiting: Story = { args: { role: 'clone', text: '' } };

/** 進行中の合図。受信の印と同じ心拍が付く。 */
export const Transient: Story = {
  args: { role: 'system', text: 'Bash を実行中…', transient: true },
};

export const System: Story = {
  args: {
    role: 'system',
    text: '確認したいことがある: 本番の DB へ migrate を当ててよいか\n（承認待ちの画面から答えられる）',
  },
};

/** 編集して置き換えた発言。古い版を見ているあいだは、その後に隠れていた往復も出す。 */
export const Versions: Story = {
  args: { role: 'human', text: '' },
  render: function Render() {
    const texts = ['資料は来週まで。', '資料は明日まで。構成案だけ先に。'];
    const [index, setIndex] = useState(0);
    return (
      <ChatMessage
        role="human"
        text={texts[index] ?? ''}
        onEdit={() => undefined}
        versions={{
          index,
          total: texts.length,
          onPrevious: () => setIndex((i) => Math.max(0, i - 1)),
          onNext: () => setIndex((i) => Math.min(texts.length - 1, i + 1)),
          hidden: [{ role: 'clone', text: '来週までなら、まず下調べから始める。' }],
        }}
      />
    );
  },
};

export const Editing: Story = {
  args: { role: 'human', text: '' },
  render: function Render() {
    const [draft, setDraft] = useState('資料は明日まで。構成案だけ先に。');
    return (
      <ChatMessage role="human" text={draft}>
        <ChatMessageEditor
          value={draft}
          onChange={setDraft}
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />
      </ChatMessage>
    );
  },
};
