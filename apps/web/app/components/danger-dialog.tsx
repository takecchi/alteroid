import type { ReactNode } from 'react';

import { Button, ErrorNote, Input } from '@alteroid/ui';

import type { DangerDialog as DangerDialogState } from '~/lib/use-danger-dialog';

// 確認してから叩く操作の `<dialog>`。済むまでは「やめる」と実行のボタン、済んだら結果と「閉じる」だけを出す。
// `dialog.confirmWord` があれば、その語を打つ欄を出す（押せる条件は `dialog.canConfirm`）。
export function DangerDialog<T>({
  dialog,
  title,
  description,
  confirmLabel,
  doneBody,
}: {
  dialog: DangerDialogState<T>;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** 済んだあとに出す結果。`dialog.done` が入っているときだけ描く。 */
  doneBody: (done: T) => ReactNode;
}) {
  const { dialogRef, confirmWord, confirmText, setConfirmText, canConfirm, busy, failure, done } =
    dialog;
  return (
    <dialog
      ref={dialogRef}
      // 実行中は Esc でも閉じない: 「やめる」が押せないのと揃えるため
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
    >
      <div className="p-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description}

        {done === undefined ? (
          <>
            {confirmWord !== undefined && (
              <label className="mt-3 block text-xs text-muted-foreground">
                続けるなら <code className="rounded bg-muted px-1 font-mono">{confirmWord}</code>{' '}
                と入力
                <Input
                  autoFocus
                  className="mt-1"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder={confirmWord}
                />
              </label>
            )}
            <ErrorNote error={failure} className="mt-3" />
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" disabled={busy} onClick={dialog.close}>
                やめる
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={!canConfirm}
                loading={busy}
                onClick={() => void dialog.run()}
              >
                {confirmLabel}
              </Button>
            </div>
          </>
        ) : (
          <>
            {doneBody(done)}
            <div className="mt-4 flex justify-end">
              <Button variant="primary" size="sm" onClick={dialog.close}>
                閉じる
              </Button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
