import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ConversationList } from './conversation-list';
import { SAMPLE_CONVERSATIONS } from './samples';

const meta = {
  title: 'Features/Chat/ConversationList',
  component: ConversationList,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ConversationList>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({
  empty = false,
  items = SAMPLE_CONVERSATIONS,
}: {
  empty?: boolean;
  items?: typeof SAMPLE_CONVERSATIONS;
}) {
  const [active, setActive] = useState<string | undefined>('conv_a');
  return (
    <div className="flex h-[480px]">
      <ConversationList
        items={empty ? [] : items}
        activeId={active}
        notes={empty ? [] : ['人間との往復 40 件を走査']}
        renderLink={(target, slot) => (
          <a
            href="#"
            aria-label={target.label}
            onClick={(event) => {
              event.preventDefault();
              setActive(target.id);
            }}
            className={slot.className}
          >
            {slot.children}
          </a>
        )}
      />
    </div>
  );
}

const args = { items: [], activeId: undefined, renderLink: () => null };

export const Default: Story = { args, render: () => <Demo /> };
export const Unread: Story = {
  args,
  render: () => (
    <Demo
      items={SAMPLE_CONVERSATIONS.map((item, index) =>
        index === 0 ? { ...item, unread: 2 } : index === 2 ? { ...item, unread: 1 } : item,
      )}
    />
  ),
};
export const WindowNotReachedStart: Story = {
  args,
  render: () => (
    <Demo items={SAMPLE_CONVERSATIONS.map((item) => ({ ...item, messagesAtLeast: true }))} />
  ),
};
export const Empty: Story = { args, render: () => <Demo empty /> };
export const Unavailable: Story = {
  args: {
    ...args,
    error: new Error('会話の一覧を取得できなかった'),
    unavailable: true,
  },
  render: (storyArgs) => (
    <div className="flex h-[480px]">
      <ConversationList {...storyArgs} />
    </div>
  ),
};
