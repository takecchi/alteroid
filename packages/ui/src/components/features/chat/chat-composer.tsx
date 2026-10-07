import { ArrowUp, Pencil, Plus, Square } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useId, useRef, useState } from 'react';

import { isMacPlatform, submitShortcutLabel } from '@/lib/platform';

import { Button, SubmitHint, Textarea, useKeyboardHintsVisible } from '../../common';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';

import type { ComposerAttachment } from './attachment-tray';

export type { ComposerAttachment } from './attachment-tray';

// 入力欄の本体に入れず添付があるときだけ読み込む: バンドル予算 1.125 MiB の内側に収めるため
const AttachmentTray = lazy(() => import('./attachment-tray'));

// 上限を 40% に抑える: iOS はソフトキーボードが出ても dvh が縮まないため
const MAX_HEIGHT = 'min(40dvh,15rem)';

// トリガーは外側の `span` にする: 押せないボタン（`disabled`）はポインタの事象を受けないため
function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const ROUND_BUTTON = 'size-11 rounded-full p-0 md:size-8';

// リサイズのつまみを出さない: タッチでは掴めず、デスクトップでも自動の高さと競うため
// `error` が無いときは `undefined` を渡す: 空の `div` の余白が残るため
export function ChatComposer({
  value,
  onChange,
  onSend,
  sending = false,
  onStopReceiving,
  error,
  placeholder = 'クローンに話しかける',
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploading = false,
  disabled = false,
  editContinuation,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending?: boolean;
  onStopReceiving?: () => void;
  error?: ReactNode;
  placeholder?: string;
  attachments?: readonly ComposerAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (key: string) => void;
  uploading?: boolean;
  disabled?: boolean;
  editContinuation?: { onCancel: () => void };
}) {
  const empty = value.trim() === '' && attachments.length === 0;
  const cannotSend = empty || disabled || uploading;
  const mac = isMacPlatform();
  const hintsVisible = useKeyboardHintsVisible();
  const shortcut = submitShortcutLabel(mac);
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasFiles = (types: readonly string[] | undefined) => types?.includes('Files') === true;
  const send = () => {
    if (!cannotSend) onSend();
  };
  return (
    <TooltipProvider delayDuration={200}>
      <div
        onDragOver={(event) => {
          if (disabled || onAttach === undefined || !hasFiles(event.dataTransfer?.types)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (disabled || onAttach === undefined || !hasFiles(event.dataTransfer?.types)) return;
          event.preventDefault();
          onAttach([...event.dataTransfer.files]);
        }}
        className="shrink-0 border-t border-border bg-background pt-3 pb-[calc(0.75rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]"
      >
        {error !== undefined && <div className="mb-2">{error}</div>}
        {editContinuation !== undefined && (
          <div
            data-slot="chat-composer-edit-continuation"
            className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <Pencil className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              発言の編集の続き。送ると、元の発言を置き換える
            </span>
            <Button size="sm" variant="ghost" onClick={editContinuation.onCancel}>
              編集をやめる
            </Button>
          </div>
        )}
        {/* フォーカスの輪とドロップ先の強調は、テキストエリアでなくこの枠に付ける */}
        <div
          data-slot="chat-composer-frame"
          className={`rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 ${dragging ? 'border-primary bg-primary/5' : 'border-input'} ${disabled ? 'opacity-60' : ''}`}
        >
          {attachments.length > 0 && (
            <div className="px-3 pt-3">
              <Suspense fallback={null}>
                <AttachmentTray
                  attachments={attachments}
                  onRemove={onRemoveAttachment}
                  disabled={uploading || disabled}
                />
              </Suspense>
            </div>
          )}
          <div>
            {/* 受信中も打てる: 塞ぐと、順番待ちのあいだに言い足したいことがあっても待つしかないため */}
            <Textarea
              rows={1}
              data-chat-input
              disabled={disabled}
              aria-describedby={hintsVisible ? hintId : undefined}
              maxHeight={MAX_HEIGHT}
              className="min-h-11 rounded-none border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
              value={value}
              placeholder={placeholder}
              onChange={(event) => onChange(event.target.value)}
              onPaste={(event) => {
                // ファイルだけが入っているときだけ引き取る: 表計算のコピーのように文字も入っているときは、文字の貼り付けを邪魔しないため
                const files = [...event.clipboardData.files];
                if (onAttach === undefined || files.length === 0) return;
                if (event.clipboardData.getData('text/plain') !== '') return;
                event.preventDefault();
                onAttach(files);
              }}
              onSubmitShortcut={onSend}
              submitDisabled={cannotSend}
            />
          </div>
          <div className="flex items-center gap-2 px-2 pb-2">
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
                    // 選び終えたら空へ戻す: 同じファイルをもう一度選べるようにするため
                    event.target.value = '';
                    if (files.length > 0) onAttach(files);
                  }}
                />
                <Hint label="ファイルを添付">
                  <Button
                    variant="ghost"
                    className={ROUND_BUTTON}
                    disabled={uploading || disabled}
                    onClick={() => fileInput.current?.click()}
                    aria-label="ファイルを添付"
                  >
                    <Plus className="size-4" aria-hidden />
                  </Button>
                </Hint>
              </>
            )}
            <SubmitHint action="送信" id={hintId} className="min-w-0 truncate" />
            <div className="ml-auto flex items-center gap-2">
              {/* 「受信をやめる」は「送る」の代わりにせず並べて出す: 送る口を消すと、追送するにはいったん受信を捨てるしかなくなるため */}
              {sending && onStopReceiving !== undefined && (
                <Hint label="受信をやめる（クローンのターンは止まらない）">
                  <Button
                    variant="default"
                    className={ROUND_BUTTON}
                    onClick={onStopReceiving}
                    aria-label="受信をやめる（クローンのターンは止まらない）"
                  >
                    <Square className="size-3.5" aria-hidden />
                  </Button>
                </Hint>
              )}
              <Hint
                label={
                  uploading
                    ? '添付を上げている'
                    : hintsVisible
                      ? `メッセージを送信（${shortcut}）`
                      : 'メッセージを送信'
                }
              >
                <Button
                  variant="primary"
                  className={ROUND_BUTTON}
                  disabled={cannotSend}
                  loading={uploading}
                  onClick={send}
                  aria-label={uploading ? '添付を上げている' : 'メッセージを送信'}
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                >
                  {!uploading && <ArrowUp className="size-4" aria-hidden />}
                </Button>
              </Hint>
            </div>
          </div>
        </div>
        {sending && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            画面を閉じてもクローンは考え続ける。順番待ちのあいだに続けて送った分は、まとめて1つの応答になる
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
