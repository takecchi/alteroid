import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ErrorNote } from '../../common';

import { ChatComposer } from './chat-composer';

/** 話しかける欄。⌘/Ctrl + Enter で送る。受信中も送れる。 */
const meta = {
  title: 'Features/Chat/ChatComposer',
  component: ChatComposer,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({ sending, error }: { sending?: boolean; error?: boolean }) {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  return (
    <div className="flex h-72 flex-col justify-end">
      <ul className="p-4 text-xs text-muted-foreground">
        {sent.map((text, index) => (
          <li key={index}>送った: {text}</li>
        ))}
      </ul>
      <ChatComposer
        value={value}
        onChange={setValue}
        onSend={() => {
          if (value.trim() === '') return;
          setSent((all) => [...all, value]);
          setValue('');
        }}
        sending={sending}
        onStopReceiving={() => undefined}
        error={
          error === true ? (
            <ErrorNote
              error={new Error('送れなかった: 429 枠に当たった（次に枠が開いたら配り直す）')}
            />
          ) : undefined
        }
      />
    </div>
  );
}

const args = { value: '', onChange: () => undefined, onSend: () => undefined };

export const Default: Story = { args, render: () => <Demo /> };
export const Sending: Story = { args, render: () => <Demo sending /> };
export const WithError: Story = { args, render: () => <Demo error /> };

/** 帯に背景色を敷かない（`opaque` を偽にする。背後の面の色がそのまま見える）。 */
export const Transparent: Story = {
  args: { ...args, opaque: false },
  render: () => (
    <div className="flex h-40 flex-col justify-end bg-card">
      <ChatComposer value="" onChange={() => undefined} onSend={() => undefined} opaque={false} />
    </div>
  ),
};
