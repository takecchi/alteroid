import { Plus, X } from 'lucide-react';
import { useRef } from 'react';

import { Button, SubmitHint, Textarea } from '../../common';

import { isImeComposing } from './ime';

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
  uploading?: boolean;
  notice?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const empty = value.trim() === '' && attachments.length === 0;
  const cannotConfirm = empty || uploading;
  const hasFiles = (types: readonly string[] | undefined) => types?.includes('Files') === true;
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
        rows={2}
        maxHeight="60vh"
        value={value}
        className="w-full bg-background text-foreground dark:bg-background"
        aria-label="発言を編集する下書き"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // IME の変換の取り消しの Escape では閉じない: 直していた文が消えるため
          if (event.key === 'Escape' && !isImeComposing(event)) {
            event.preventDefault();
            onCancel();
            return;
          }
        }}
        onPaste={(event) => {
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
