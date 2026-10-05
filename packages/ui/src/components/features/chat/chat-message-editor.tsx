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
  /*
   * **クリックで textarea になり、送信で確定する**
   * （チャットのメッセージ編集、#1010）。キー操作は
   * 既存の送信欄（`ChatComposer`）と揃える —
   * `⌘/Ctrl + Enter` で確定、IME 変換中の Enter では
   * 確定しない（`chat.ime-enter.test.tsx` と同じ門）。
   * `Escape` で取消——編集前の内容は保存していないが、
   * `line.text`（サーバ確定済みの本文）は変えていない
   * ので、いつでも同じ下書きから開き直せる。
   */
  return (
    <div className="flex w-full min-w-64 flex-col gap-2">
      <Textarea
        autoFocus
        // 元の吹き出しの高さを下回らない: 行数ぶん（最低2行）で開き、
        // `field-sizing-content` に対応した描画系では折り返しも含めて本文に
        // 合わせて伸びる（`Textarea` 既定の `field-sizing-fixed` を上書き）。
        rows={Math.max(2, value.split('\n').length)}
        value={value}
        className="field-sizing-content max-h-[60vh] w-full bg-background text-foreground dark:bg-background"
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
