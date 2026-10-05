import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChatMessage, ChatMessageList } from './chat-message';
import { ChatTurnFailure, TurnFailureNote } from './turn-failure';

/** 送信が失敗したときの見せ方。会話の中の知らせ（`ChatTurnFailure`）と入力欄の上の帯（`TurnFailureNote`）。 */
const meta = {
  title: 'Features/Chat/TurnFailure',
  component: ChatTurnFailure,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatTurnFailure>;

export default meta;
type Story = StoryObj<typeof meta>;

const FAILURE_TEXT = 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。';

/** 失敗したターン。直前の発言と、普通の返答のあいだに置いて見分けを確かめる。 */
export const FailedWithRetry: Story = {
  args: { kind: 'failed', text: FAILURE_TEXT, onRetry: () => undefined },
  render: (args) => (
    <div className="max-w-3xl">
      <ChatMessageList>
        <ChatMessage role="human" text="来週の登壇資料の構成案を作って" />
        <ChatTurnFailure {...args} />
      </ChatMessageList>
    </div>
  ),
};

/** 再送できない状態（後ろに発言が続く等）では「もう一度送る」を出さない。 */
export const FailedWithoutRetry: Story = {
  args: { kind: 'failed', text: FAILURE_TEXT },
  render: (args) => (
    <div className="max-w-3xl">
      <ChatMessageList>
        <ChatTurnFailure {...args} />
      </ChatMessageList>
    </div>
  ),
};

/** 利用上限での保持。クローンが自分で試し直すので再送は置かない。 */
export const Held: Story = {
  args: {
    kind: 'held',
    text: 'いま利用上限に当たっているので、この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して返信する。',
    onRetry: () => undefined,
  },
  render: (args) => (
    <div className="max-w-3xl">
      <ChatMessageList>
        <ChatTurnFailure {...args} />
      </ChatMessageList>
    </div>
  ),
};

/** 入力欄の上の帯: 認証切れ（導線つき）。 */
export const NoteAuth: Story = {
  args: { kind: 'failed', text: '' },
  render: () => (
    <div className="max-w-3xl">
      <TurnFailureNote
        message="結果なしで終了: success（result_is_error） / Not logged in · Please run /login"
        action={() => (
          <a href="#tokens" className="text-xs underline underline-offset-2">
            認証トークンの画面を開く
          </a>
        )}
      />
    </div>
  ),
};

/** 入力欄の上の帯: 利用上限。 */
export const NoteQuota: Story = {
  args: { kind: 'failed', text: '' },
  render: () => (
    <div className="max-w-3xl">
      <TurnFailureNote message="結果なしで終了: error_during_execution（result_subtype） / You've hit your org's monthly spend limit" />
    </div>
  ),
};

/** 入力欄の上の帯: 種類が分からない失敗。 */
export const NoteOther: Story = {
  args: { kind: 'failed', text: '' },
  render: () => (
    <div className="max-w-3xl">
      <TurnFailureNote message="結果なしで終了: error_during_execution（result_subtype） / ECONNRESET" />
    </div>
  ),
};
