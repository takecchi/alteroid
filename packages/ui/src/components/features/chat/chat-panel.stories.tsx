import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ChatComposer } from './chat-composer';
import { ChatHeader } from './chat-header';
import { ChatMessage, ChatMessageList } from './chat-message';
import { ConversationList } from './conversation-list';
import { SAMPLE_CONVERSATIONS } from './samples';

const meta = {
  title: 'Features/Chat/ChatPanel',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

interface SampleLine {
  key: string;
  role: 'human' | 'clone' | 'system';
  text: string;
  transient?: boolean;
}

const FIXED: readonly SampleLine[] = [
  { key: '1', role: 'human', text: '来週の登壇資料、構成案だけ先に作っておいて。' },
  {
    key: '2',
    role: 'clone',
    text: '構成案をマネージャーに頼んだ。**3部構成**で考えている:\n\n1. 背景（なぜクローンか）\n2. 設計（層とモデル帯）\n3. 運用で踏んだ地雷',
  },
  {
    key: '3',
    role: 'system',
    text: '確認したいことがある: 社外に出す資料に実測の費用を載せてよいか\n（承認待ちの画面から答えられる）',
  },
];

// 行の配列を state に積まず最後の1往復だけを持つ: 刈る規則 `retainedBy` を迂回できる2つ目の入れ物を作らないため
function Panel() {
  const [exchange, setExchange] = useState<{ text: string; reply: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const sending = exchange !== null && exchange.reply === null;

  const send = () => {
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    setExchange({ text, reply: null });
    setTimeout(() => {
      setExchange((current) =>
        current?.text === text
          ? { text, reply: `受け取った。「${text}」を記憶に照らして考える。` }
          : current,
      );
    }, 1400);
  };

  const lines: SampleLine[] = [...FIXED];
  if (exchange !== null) {
    lines.push({ key: 'sent', role: 'human', text: exchange.text });
    lines.push(
      exchange.reply === null
        ? { key: 'thinking', role: 'system', text: '考えている…', transient: true }
        : { key: 'reply', role: 'clone', text: exchange.reply },
    );
  }

  return (
    <div className="flex h-dvh">
      <ConversationList
        items={SAMPLE_CONVERSATIONS}
        activeId="conv_a"
        renderLink={(target, slot) => (
          <a href="#" aria-label={target.label} className={slot.className}>
            {slot.children}
          </a>
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          conversationId="conv_01J8ZK4Q3M7R2D9XW5T6YB0HNE"
          onInterrupt={() => undefined}
          onEnd={() => undefined}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
          <ChatMessageList>
            {lines.map((line) => (
              <ChatMessage
                key={line.key}
                role={line.role}
                text={line.text}
                transient={line.transient}
                onEdit={line.role === 'human' ? () => undefined : undefined}
              />
            ))}
          </ChatMessageList>
        </div>
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={send}
          sending={sending}
          onStopReceiving={() => setExchange(null)}
        />
      </div>
    </div>
  );
}

export const Default: Story = { render: () => <Panel /> };
