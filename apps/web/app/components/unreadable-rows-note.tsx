import { useState } from 'react';

import { Button, ConfirmDialog, ErrorNote, WarnNote } from '@alteroid/ui';

export function UnreadableRowsNote({
  noun,
  unreadable,
  removeUnreadable,
  hand,
}: {
  noun: string;
  unreadable: { count: number; rows: readonly { id: string; reason: string }[] };
  removeUnreadable: (ids: readonly string[]) => Promise<unknown>;
  hand: string;
}) {
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
        {unreadable.rows.map((row) => (
          <li key={row.id}>
            <code className="font-mono break-all">{row.id}</code>
            {' — '}
            {row.reason}{' '}
            <Button
              variant="danger"
              size="sm"
              loading={busyId === row.id}
              aria-label={`${row.id} の行を消す`}
              onClick={() => setConfirmingId(row.id)}
            >
              この行を消す
            </Button>
            <ConfirmDialog
              open={confirmingId === row.id}
              onOpenChange={(open) => {
                if (!open) setConfirmingId(null);
              }}
              title={`読めない${noun}の行「${row.id}」を消しますか`}
              description={`この行は消え、元に戻せません。中身はこの画面では読めないので、消したあとに同じ${noun}を入れ直すには元の内容が要ります。`}
              confirmLabel="消す"
              destructive
              onConfirm={() => void remove(row.id)}
            />
          </li>
        ))}
      </ul>
      {noId > 0 && (
        <p className="mt-1">
          id が取れない行が {noId} 件ある。ここでは消せない（{hand} を手で直す）。
        </p>
      )}
      <ErrorNote error={failure} />
    </WarnNote>
  );
}
