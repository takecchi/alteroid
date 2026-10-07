import { Plus, X } from 'lucide-react';
import { useRef } from 'react';

import { Button, SubmitHint, Textarea } from '../../common';

import { isImeComposing } from './ime';

/**
 * 送った発言を直す下書き。`ChatMessage` の `children` に渡す。
 *
 * - ⌘ / Ctrl + Enter で確定、Escape でやめる（IME の変換中の Escape は変換の取り消しなので、やめない）
 * - IME の変換を確定する Enter では何もしない（`ime.ts`）
 * - 空白だけの下書きでは確定できない（添付が残っていれば、本文が空でも確定できる）
 * - `attachments` — この発言の添付。**編集では引き継ぐ**ので、外さない限り新しい版にも付く。
 *   外す口は `onRemoveAttachment`（#3399）
 * - `onAttach`（渡したときだけ有効）— [+]・貼り付け（ファイルだけのとき）・ドロップのどれからも呼ばれる
 *   （入力欄 `ChatComposer` と同じ。個数や大きさの検査は呼ぶ側）。`uploading` のあいだは確定できない
 * - `notice` — 足せなかった理由など、枠の中に出す案内
 */
export function ChatMessageEditor({
  value,
  onChange,
  onConfirm,
  onCancel,
  attachments = [],
  onRemoveAttachment,
  onAttach,
  uploading = false,
  notice,
}: {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  attachments?: readonly { id: string; name: string; sizeLabel: string }[];
  onRemoveAttachment?: (id: string) => void;
  onAttach?: (files: File[]) => void;
  /** 添付を上げている最中か。真のあいだは確定できない（二重に上げない）。 */
  uploading?: boolean;
  notice?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const empty = value.trim() === '' && attachments.length === 0;
  const cannotConfirm = empty || uploading;
  const hasFiles = (types: readonly string[] | undefined) => types?.includes('Files') === true;
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
    <div
      className="flex w-full min-w-64 flex-col gap-2"
      onDragOver={(event) => {
        if (onAttach !== undefined && hasFiles(event.dataTransfer?.types)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (onAttach === undefined || !hasFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        onAttach([...event.dataTransfer.files]);
      }}
    >
      <Textarea
        autoFocus
        // 元の吹き出しの高さを下回らない: 行数ぶん（最低2行）で開き、
        // `field-sizing-content` に対応した描画系では折り返しも含めて本文に
        // 合わせて伸びる（`Textarea` 既定の `field-sizing-fixed` を上書き）。
        rows={2}
        maxHeight="60vh"
        value={value}
        className="w-full bg-background text-foreground dark:bg-background"
        aria-label="発言を編集する下書き"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // IME の変換の取り消しの Escape では閉じない（直していた文が消える。#3394）。
          if (event.key === 'Escape' && !isImeComposing(event)) {
            event.preventDefault();
            onCancel();
            return;
          }
        }}
        onPaste={(event) => {
          // ファイルだけが入っているときだけ引き取る（`ChatComposer` と同じ）。
          const files = [...event.clipboardData.files];
          if (onAttach === undefined || files.length === 0) return;
          if (event.clipboardData.getData('text/plain') !== '') return;
          event.preventDefault();
          onAttach(files);
        }}
        onSubmitShortcut={onConfirm}
        submitDisabled={cannotConfirm}
      />
      {notice !== undefined && (
        <p role="status" className="text-xs whitespace-pre-line text-warn">
          {notice}
        </p>
      )}
      {attachments.length > 0 && (
        <ul aria-label="この発言の添付" className="flex flex-wrap gap-2">
          {attachments.map((item) => (
            <li
              key={item.id}
              className="flex max-w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
            >
              <span className="min-w-0 truncate" title={item.name}>
                {item.name}
              </span>
              <span className="shrink-0 text-muted-foreground" data-numeric>
                {item.sizeLabel}
              </span>
              {onRemoveAttachment !== undefined && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={uploading}
                  aria-label={`${item.name} を外す`}
                  onClick={() => onRemoveAttachment(item.id)}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        {onAttach !== undefined && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label="添えるファイルを選ぶ"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                if (files.length > 0) onAttach(files);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={uploading}
              aria-label="ファイルを添付"
              onClick={() => fileInput.current?.click()}
            >
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </>
        )}
        <Button size="sm" variant="primary" disabled={cannotConfirm} onClick={onConfirm}>
          確定
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          キャンセル
        </Button>
        <SubmitHint action="確定" />
      </div>
    </div>
  );
}
