import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ErrorNote } from '../../common';

import { ChatComposer, type ComposerAttachment } from './chat-composer';

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
  text,
  attachments,
  uploading,
  disabled,
}: {
  sending?: boolean;
  error?: boolean;
  lines?: number;
  text?: string;
  attachments?: ComposerAttachment[];
  uploading?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(
    text ?? Array.from({ length: lines }, (_, i) => `${i + 1} 行目の下書き`).join('\n'),
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
        attachments={attachments}
        onAttach={() => undefined}
        onRemoveAttachment={() => undefined}
        uploading={uploading}
        disabled={disabled}
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

const FILES: ComposerAttachment[] = [
  { key: 'a', name: 'design-notes.pdf', sizeLabel: '1.2 MB' },
  { key: 'b', name: 'screenshot.png', sizeLabel: '340 KB' },
];

export const Empty: Story = { args, render: () => <Demo /> };
export const Typing: Story = {
  args,
  render: () => <Demo text={'来週の予定を整理して。\n優先度の高いものから順に。'} />,
};
export const WithAttachments: Story = {
  args,
  render: () => <Demo text="これを見て" attachments={FILES} />,
};
export const AttachmentsOnly: Story = { args, render: () => <Demo attachments={FILES} /> };
export const Uploading: Story = {
  args,
  render: () => <Demo text="これを見て" attachments={FILES} uploading />,
};
export const Sending: Story = { args, render: () => <Demo sending text="続きもお願い" /> };
export const Disabled: Story = { args, render: () => <Demo disabled text="送れない" /> };
export const WithError: Story = { args, render: () => <Demo error text="再送できる" /> };

export const LongDraft: Story = { args, render: () => <Demo lines={30} /> };
export const TenLines: Story = { args, render: () => <Demo lines={10} /> };

const MANY: ComposerAttachment[] = Array.from({ length: 10 }, (_, i) => ({
  key: `m${i}`,
  name: `meeting-notes-${i + 1}.pdf`,
  sizeLabel: '1.2 MB',
}));
export const ManyAttachments: Story = {
  args,
  render: () => <Demo text="これを見て" attachments={MANY} />,
};
export const LongAttachmentName: Story = {
  args,
  render: () => (
    <Demo attachments={[{ key: 'l', name: `${'a'.repeat(120)}.tar.gz`, sizeLabel: '24 MB' }]} />
  ),
};
