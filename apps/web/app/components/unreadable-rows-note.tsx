import { useState, type ReactNode } from 'react';

import { Button, ConfirmDialog, ErrorNote, WarnNote } from '@alteroid/ui';

type Tail =
  // id が取れない行の件数（count - rows.length）を、手で直す先の名前つきで言う
  | { hand: string; footer?: undefined }
  // 末尾の説明を丸ごと差し替える（id が取れない行も rows に載せる画面向け）
  | { footer: ReactNode; hand?: undefined };

export function UnreadableRowsNote({
  noun,
  unreadable,
  removeUnreadable,
  description = `この行は消え、元に戻せません。中身はこの画面では読めないので、消したあとに同じ${noun}を入れ直すには元の内容が要ります。`,
  renderFailure = (failure) => <ErrorNote error={failure} />,
  ...tail
}: {
  noun: string;
  unreadable: {
    count: number;
    rows: readonly { id?: string; label?: string; reason: string }[];
  };
  removeUnreadable: (ids: readonly string[]) => Promise<unknown>;
  // 確認ダイアログの説明
  description?: string;
  // 消すのに失敗したときの枠
  renderFailure?: (failure: unknown) => ReactNode;
} & Tail) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function remove(id: string) {
    setBusyId(id);
    setFailure(undefined);
    try {
      await removeUnreadable([id]);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusyId(null);
    }
  }

  const noId = unreadable.count - unreadable.rows.length;
  return (
    <WarnNote block className="m-4">
      <p>
        読めない{noun}の行が {unreadable.count} 件ある（消えたのではなく、読めない形で
        入っている）。この一覧には載っていない。
      </p>
      <ul className="mt-1 list-disc pl-5">
        {unreadable.rows.map(({ id, label, reason }, index) => (
          <li key={id ?? `:${index}`}>
            {id === undefined && label === undefined ? (
              '（id もラベルも取れない）'
            ) : (
              <>
                {id !== undefined && <code className="font-mono break-all">{id}</code>}
                {id !== undefined && label !== undefined && ' / '}
                {label !== undefined && <span>{label}</span>}
              </>
            )}
            {' — '}
            {reason}
            {id !== undefined && (
              <>
                {' '}
                <Button
                  variant="danger"
                  size="sm"
                  loading={busyId === id}
                  aria-label={`${id} の行を消す`}
                  onClick={() => setConfirmingId(id)}
                >
                  この行を消す
                </Button>
                {/* 押した瞬間には実行せず確認を挟む: 消した行は戻せないため */}
                <ConfirmDialog
                  open={confirmingId === id}
                  onOpenChange={(open) => {
                    if (!open) setConfirmingId(null);
                  }}
                  title={`読めない${noun}の行「${id}」を消しますか`}
                  description={description}
                  confirmLabel="消す"
                  destructive
                  onConfirm={() => void remove(id)}
                />
              </>
            )}
          </li>
        ))}
      </ul>
      {tail.footer !== undefined
        ? tail.footer
        : noId > 0 && (
            <p className="mt-1">
              id が取れない行が {noId} 件ある。ここでは消せない（{tail.hand} を手で直す）。
            </p>
          )}
      {renderFailure(failure)}
    </WarnNote>
  );
}
