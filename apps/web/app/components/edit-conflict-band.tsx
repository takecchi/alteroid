import type { ReactNode } from 'react';

import { Button } from '@alteroid/ui';

// 版付きの編集が 409（開いたあとに裏で変わった）で断られたときの帯。下書きは呼び元が残してある。
// 版を握り直す `adoptConflictVersion` と保存 `save` は呼び元に残す: 版の持ち方（ref）と保存の中身が編集欄ごとに違うため。
export function EditConflictBand({
  className,
  heading,
  children,
  retryLabel,
  discardLabel,
  busy,
  onRetry,
  onDiscard,
}: {
  className: string;
  // 何が変わったかを言う見出し（太字）。名詞の前後の空白が編集欄ごとに違う（「この本文が」「この task が」）ので、文をそのまま受ける。
  heading: string;
  // いまの内容（CodeBlock など）。
  children: ReactNode;
  retryLabel: string;
  discardLabel: string;
  busy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alert"
      className={`${className} rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm`}
    >
      <p className="mb-2 break-words">
        <strong>{heading}</strong>
        保存していない。下書きはそのまま残してある。
      </p>
      {children}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onRetry}>
          {retryLabel}
        </Button>
        <Button size="sm" disabled={busy} onClick={onDiscard}>
          {discardLabel}
        </Button>
      </div>
    </div>
  );
}
