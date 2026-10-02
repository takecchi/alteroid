import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { Button, ErrorNote } from '@alteroid/ui';

/**
 * 読めない行の断り（`GET /permission-grants` / `GET /access` の `rowsUnreadable`。issue #2536）。
 * `routes/tokens.tsx` の `UnreadableRowsNote`（#2346）と同じ形。
 *
 * **「消えたのではなく、読めない形で入っている」と言う。** 識別は id と不正な欄名だけで、行の
 * 中身（許可の本文・email など）は出ない（デーモンが返さない）。**id が取れない行は `rows` に
 * 無いので、ボタンも無い**（指す名前が無い。`count` が `rows.length` より多いぶんがそれ）。
 * 消すのは、id を指す消すボタンだけである（`alteroid permission|access remove-unreadable` と
 * 同じ）。
 */
export function UnreadableRowsNote({
  noun,
  unreadable,
  removeUnreadable,
  hand,
}: {
  /** 「許可」「アカウント」。 */
  noun: string;
  unreadable: { count: number; rows: readonly { id: string; reason: string }[] };
  /** id を指して消す（`useRemoveUnreadable…`）。 */
  removeUnreadable: (ids: readonly string[]) => Promise<unknown>;
  /** id が取れない行を手で直すファイル。 */
  hand: string;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
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
    <div
      role="status"
      className="m-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 break-words">
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
                onClick={() => void remove(row.id)}
              >
                この行を消す
              </Button>
            </li>
          ))}
        </ul>
        {noId > 0 && (
          <p className="mt-1">
            id が取れない行が {noId} 件ある。ここでは消せない（{hand} を手で直す）。
          </p>
        )}
        <ErrorNote error={failure} />
      </div>
    </div>
  );
}
