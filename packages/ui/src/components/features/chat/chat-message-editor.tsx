import { Button, Textarea } from '../../common';

import { isSubmitShortcut } from './ime';

/**
 * 送った発言を直す下書き。`ChatMessage` の `children` に渡す。
 *
 * - ⌘ / Ctrl + Enter で確定、Escape でやめる
 * - IME の変換を確定する Enter では何もしない（`ime.ts`）
 * - 空白だけの下書きでは確定できない
 */
export function ChatMessageEditor({
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const empty = value.trim() === '';
  return (
    <div className="flex min-w-64 flex-col gap-2">
      <Textarea
        autoFocus
        rows={2}
        value={value}
        className="text-foreground"
        aria-label="発言を編集する下書き"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (isSubmitShortcut(event)) {
            event.preventDefault();
            if (!empty) onConfirm();
          }
        }}
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={empty} onClick={onConfirm}>
          確定
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}
