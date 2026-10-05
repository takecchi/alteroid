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

function Demo({
  sending,
  error,
  lines = 0,
}: {
  sending?: boolean;
  error?: boolean;
  lines?: number;
}) {
  const [value, setValue] = useState(
    Array.from({ length: lines }, (_, i) => `${i + 1} 行目の下書き`).join('\n'),
  );
  const [sent, setSent] = useState<string[]>([]);
  return (
    <div className="flex h-[calc(100dvh-2rem)] min-h-72 flex-col justify-end">
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

/** 30 行の下書き。上限で止まり、内側をスクロールする。 */
export const LongDraft: Story = { args, render: () => <Demo lines={30} /> };
/** 10 行の下書き。 */
export const TenLines: Story = { args, render: () => <Demo lines={10} /> };
