import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ErrorNote } from '../../common';

import { ChatComposer, type ComposerAttachment } from './chat-composer';

/** 話しかける欄。1つの枠に、テキストエリアと下段の [+]（添付）・[▶]（送信）。⌘（Mac）/ Ctrl + Enter で送る。ボタンはホバー・フォーカスでヒントが出る。受信中も送れる。 */
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

/** 空。案内の文（⌘ / Ctrl + Enter で送信）が出る。送信ボタンは押せない。 */
export const Empty: Story = { args, render: () => <Demo /> };
/** 入力中。 */
export const Typing: Story = {
  args,
  render: () => <Demo text={'来週の予定を整理して。\n優先度の高いものから順に。'} />,
};
/** 添付あり（本文は空でも送れる）。 */
export const WithAttachments: Story = {
  args,
  render: () => <Demo text="これを見て" attachments={FILES} />,
};
/** 添付だけ（本文なし）。 */
export const AttachmentsOnly: Story = { args, render: () => <Demo attachments={FILES} /> };
/** 添付を上げている最中。送信ボタンは回って押せず、[+] も止まる。 */
export const Uploading: Story = {
  args,
  render: () => <Demo text="これを見て" attachments={FILES} uploading />,
};
/** 受信中。「受信をやめる」を [▶] と並べて出し、続けて送れる。 */
export const Sending: Story = { args, render: () => <Demo sending text="続きもお願い" /> };
/** 無効。欄ぜんたいが使えない。 */
export const Disabled: Story = { args, render: () => <Demo disabled text="送れない" /> };
export const WithError: Story = { args, render: () => <Demo error text="再送できる" /> };

/** 30 行の下書き。上限で止まり、内側をスクロールする。 */
export const LongDraft: Story = { args, render: () => <Demo lines={30} /> };
/** 10 行の下書き。 */
export const TenLines: Story = { args, render: () => <Demo lines={10} /> };

const MANY: ComposerAttachment[] = Array.from({ length: 10 }, (_, i) => ({
  key: `m${i}`,
  name: `meeting-notes-${i + 1}.pdf`,
  sizeLabel: '1.2 MB',
}));
/** 添付 10 件。チップの並びは高さに上限があり、内側をスクロールする（テキストエリアと [▶] が押し出されない）。 */
export const ManyAttachments: Story = {
  args,
  render: () => <Demo text="これを見て" attachments={MANY} />,
};
/** 折り返せない長い名前の添付。名前は切れ、ホバーで全体が出る。 */
export const LongAttachmentName: Story = {
  args,
  render: () => (
    <Demo attachments={[{ key: 'l', name: `${'a'.repeat(120)}.tar.gz`, sizeLabel: '24 MB' }]} />
  ),
};
