import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChatMessage, ChatMessageList } from './chat-message';
import { ChatTurnFailure, TurnFailureNote } from './turn-failure';

const meta = {
  title: 'Features/Chat/TurnFailure',
  component: ChatTurnFailure,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatTurnFailure>;

export default meta;
type Story = StoryObj<typeof meta>;

const FAILURE_TEXT = 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。';

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

export const NoteAuth: Story = {
  args: { kind: 'failed', text: '' },
  render: () => (
    <div className="max-w-3xl">
      <TurnFailureNote
        kind="auth"
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

export const NoteQuota: Story = {
  args: { kind: 'failed', text: '' },
  render: () => (
    <div className="max-w-3xl">
      <TurnFailureNote
        kind="quota"
        message="結果なしで終了: error_during_execution（result_subtype） / You've hit your org's monthly spend limit"
      />
    </div>
  ),
};

export const NoteOther: Story = {
  args: { kind: 'failed', text: '' },
  render: () => (
    <div className="max-w-3xl">
      <TurnFailureNote
        kind="other"
        message="結果なしで終了: error_during_execution（result_subtype） / ECONNRESET"
      />
    </div>
  ),
};
