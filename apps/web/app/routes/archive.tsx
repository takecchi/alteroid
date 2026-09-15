import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useRemoveArchive } from '~/hooks/mutations';
import { useArchive, useArchiveSessions } from '~/hooks/queries';
import { ApiError } from '~/lib/api';
import { formatDateTime } from '~/lib/format';
import type { ArchiveEntry, ArchiveSessionSummary } from '~/lib/types';

/**
 * `/archive` — セッション生ログの退避（可観測性の最下段）。CLI の `/archive`
 * `/archive sessions` `/archive remove <id>`、クローンの道具 `archive_remove`
 * と同じ口（#698 / #776）。
 *
 * **Issue #776 が埋めた画面である。** それまで Web UI に archive を直接扱う
 * ルートが1つも無く、消す操作は HTTP（`DELETE /archive/:id`）とクローンの道具
 * （`archive_remove`）にしか無かった——人間の対話面（CLI・Web UI）のうち
 * CLI には読み取りだけ在り（`/archive` `/archive <id>` `/archive sessions`）、
 * Web UI には読み取りすら無かった。**能力の欠落ではなく対話面の利便の欠落**
 * （ストア層・HTTP 層は #698 で既に在ったので、ここはそれを呼ぶだけである）。
 *
 * **独立した `/archive` を選んだ**（`manager-detail.tsx` のセッションログ
 * （`GET /managers/:id/transcript`）の隣に置く案もあったが採らなかった）。
 * 理由: `apps/web/app/routes.ts` 冒頭のコメント「画面の割り当ては CLI で
 * できることに揃えてある」——CLI には既に独立した `/archive` 系コマンドが
 * 在り、`manager-detail` はその1経路（走行中/直近のマネージャーの transcript）
 * に過ぎない。`archive` の行はマネージャーが跨いだセッションや、そのマネー
 * ジャーの画面からは辿れない古い退避も含むので、`manager-detail` に埋めると
 * 到達できない行が残る。
 *
 * **本文（生ログ全体）を読む画面はここでは足していない。** #776 の範囲は
 * 「消す操作を対話面に出す」ことで、行の特定に要る情報（id / sessionId /
 * 時刻 / 使用バイト数 / 削除済みかどうか）は一覧だけで足りる——同じ判断は
 * CLI 側の `/archive sessions`（このページの「sessionId ごとの集計」）が
 * 動機だったものと同じである。本文を読みたいときは CLI の `/archive <id>`
 * か `GET /archive/:id` を使うこと。
 */
export default function Archive() {
  return (
    <Page title="アーカイブ" description="セッション生ログの退避。本文だけを消せる（行は残る）">
      <div className="flex flex-col gap-4">
        <SessionsSummary />
        <EntryList />
      </div>
    </Page>
  );
}

/**
 * `sessionId` ごとの集計。CLI の `/archive sessions` と同じもの——
 * 「1本が何度積まれているか」を個々の大きさより先に見せる。
 */
function SessionsSummary() {
  const { data, error, isLoading } = useArchiveSessions();

  return (
    <Card>
      <CardHeader
        title="sessionId ごとの集計"
        subtitle="alteroid chat の /archive sessions と同じもの"
      />
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : data === undefined ? null : data.sessions.length === 0 ? (
        <Empty>（生ログはまだありません）</Empty>
      ) : (
        <ul>
          {data.sessions.map((session) => (
            <SessionRow key={session.sessionId} session={session} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function SessionRow({ session }: { session: ArchiveSessionSummary }) {
  return (
    <li className="border-b border-border px-4 py-2 text-xs last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono break-all">{session.sessionId}</span>
        <Badge>行数 {session.rows}</Badge>
        <span className="text-muted">
          使用量合計 {session.storedBytes}バイト（最大1行 {session.maxStoredBytes}バイト）
        </span>
      </div>
      <div className="mt-1 text-muted">
        {formatDateTime(session.firstAt)} 〜 {formatDateTime(session.lastAt)}
      </div>
    </li>
  );
}

/** 一覧本体。行ごとに「本文を消す」を持つ——これが #776 の中心である。 */
function EntryList() {
  const { data, error, isLoading } = useArchive();

  return (
    <Card>
      <CardHeader
        title="一覧"
        subtitle="alteroid chat の /archive と同じもの。新しい順"
        action={data === undefined ? undefined : <Badge>{data.entries.length}</Badge>}
      />
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : data === undefined ? null : data.entries.length === 0 ? (
        <Empty>（生ログはまだありません）</Empty>
      ) : (
        <ul>
          {data.entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 1件の退避。**409（走行中のマネージャーの退避）は黙って失敗させない。**
 *
 * サーバの `guardArchiveRemoval`（`packages/core/src/manager.ts`）は既定で
 * 走行中マネージャーの退避を拒み、`overrideReason` の非空文字列だけを
 * 「override する」という意思表示として受け取る。ここではまず理由なしで
 * 叩き、`ApiError.status === 409` が返ったときだけ理由の入力欄を出す——
 * 理由を毎回求めると、拒まれない大多数の行でも1ステップ増える。
 */
function EntryRow({ entry }: { entry: ArchiveEntry }) {
  const removeArchive = useRemoveArchive();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const removed = entry.removedAt !== undefined;
  const denied = failure instanceof ApiError && failure.status === 409;

  async function remove(overrideReason?: string) {
    setBusy(true);
    setFailure(undefined);
    try {
      await removeArchive(entry.id, overrideReason);
      // 成功すれば一覧の取り直しで `removedAt` が付いた行に置き換わる
      // （`useRemoveArchive` が `KEY.archive` / `KEY.archiveSessions` を
      // 取り直す）。ここで楽観的に表示を変えない——`mutations.ts` 冒頭の
      // 「原則、楽観更新はしない」。
      setReason('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 text-xs last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono break-all">{entry.id}</span>
        {removed && <Badge tone="warn">本文は削除済み</Badge>}
        {entry.continuity !== undefined && <Badge tone="neutral">{entry.continuity}</Badge>}
      </div>
      <div className="mt-1 text-muted">
        session {entry.sessionId} ・ {entry.storedBytes}バイト ・ {formatDateTime(entry.at)}
      </div>

      {removed ? (
        <div className="mt-1 text-muted">
          削除: {entry.removedAt === undefined ? '' : formatDateTime(entry.removedAt)}
          {entry.removedBytes !== undefined && `（${entry.removedBytes}バイト）`}
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={busy}
              onClick={() => void remove()}
            >
              本文を消す
            </Button>
          </div>

          {denied && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                value={reason}
                placeholder="走行中のマネージャーの退避——上書きする理由"
                onChange={(event) => setReason(event.target.value)}
              />
              <Button
                variant="danger"
                size="sm"
                className="shrink-0"
                loading={busy}
                // 理由なしでは override させない——`guardArchiveRemoval` 自身が
                // 非空文字列を意思表示として扱う契約（`packages/core/src/manager.ts`）
                // をここでも守る。
                disabled={busy || reason.trim() === ''}
                onClick={() => void remove(reason.trim())}
              >
                理由を付けて消す
              </Button>
            </div>
          )}

          <ErrorNote error={failure} className="mt-2" />
        </>
      )}
    </li>
  );
}
