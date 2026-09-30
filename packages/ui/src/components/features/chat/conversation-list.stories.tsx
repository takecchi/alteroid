import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ConversationList } from './conversation-list';
import { SAMPLE_CONVERSATIONS } from './samples';

/** 会話の一覧。切ったことは但し書き（`notes`）で言う。 */
const meta = {
  title: 'Features/Chat/ConversationList',
  component: ConversationList,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ConversationList>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({ empty = false }: { empty?: boolean }) {
  const [active, setActive] = useState<string | undefined>('conv_a');
  return (
    <div className="flex h-[480px]">
      <ConversationList
        items={empty ? [] : SAMPLE_CONVERSATIONS}
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
export const Empty: Story = { args, render: () => <Demo empty /> };

/**
 * 口で従来の表示に合わせた形（`apps/web` の会話の画面が渡しているもの）。
 * 往復の数を包まず、選択中は `bg-muted`、新しい会話のボタンは Tab の順路に残る。
 */
export const PlainRows: Story = {
  args,
  render: () => (
    <div className="flex h-[480px]">
      <ConversationList
        items={SAMPLE_CONVERSATIONS}
        activeId="conv_a"
        numericCount={false}
        rowClassName="block border-b border-border px-3 py-2 hover:bg-muted"
        activeRowClassName="bg-muted"
        newConversationTabStop
        renderLink={(target, slot) => (
          <a href="#" aria-label={target.label} className={slot.className || undefined}>
            {slot.children}
          </a>
        )}
      />
    </div>
  ),
};
