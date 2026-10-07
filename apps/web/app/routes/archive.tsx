import { JournalTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Empty,
  ErrorNote,
  Input,
  Spinner,
  cn,
} from '@alteroid/ui';
import { useRemoveArchive, useArchive, useArchiveSessions, ApiError } from '@alteroid/swr';
import { formatBytes, formatDateTime } from '@alteroid/logic';
import type { ArchiveEntry, ArchiveSessionSummary } from '@alteroid/logic';

// 独立した /archive にする（manager-detail に埋めない）: マネージャーの画面からは辿れない古い退避も含み、埋めると到達できない行が残るため
const ARCHIVE_EMPTY =
  '退避された生ログはまだありません。会話の生ログが退避されるとここに並び、容量が増えたときに本文を消せます。';

export default function Archive() {
  return (
    <Page
      tabs={<JournalTabs />}
      title="アーカイブ"
      description="退避した会話の生ログです。容量が増えたときに、本文だけを消せます（消しても一覧の行は残ります）"
    >
      <div className="flex flex-col gap-4">
        <SessionsSummary />
        <EntryList />
      </div>
    </Page>
  );
}

function SessionsSummary() {
  const { data, error, isLoading, isValidating, mutate } = useArchiveSessions();

  return (
    <Card>
      <CardHeader
        title="会話ごとの集計"
        subtitle="同じ会話が何度退避されたかを、1件ずつの大きさより先に見られます"
      />
      <LoadError
        what="集計"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      {isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : data === undefined ? null : data.sessions.length === 0 ? (
        <Empty inset="card">{ARCHIVE_EMPTY}</Empty>
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

const CONTINUITY_LABELS = {
  first: '最初の退避',
  continues: '前回の続き',
  diverged: '前回と内容が異なる',
  unknown: '前回との関係は不明',
} satisfies Record<NonNullable<ArchiveEntry['continuity']>, string>;

function continuityLabel(value: string): string {
  return (CONTINUITY_LABELS as Record<string, string | undefined>)[value] ?? '前回との関係は不明';
}

function TechnicalIds({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <details className="mt-1 text-muted-foreground">
      <summary className="cursor-pointer">詳しい情報（開発者向け）</summary>
      {rows.map((row) => (
        <div key={row.label} className="mt-1 min-w-0">
          {row.label}: <span className="font-mono break-all">{row.value}</span>
        </div>
      ))}
    </details>
  );
}

function SessionRow({ session }: { session: ArchiveSessionSummary }) {
  return (
    <li className="border-b border-border px-4 py-2 text-xs last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{formatDateTime(session.firstAt)} からの会話</span>
        <Badge>行数 {session.rows}</Badge>
        <span className="text-muted-foreground">
          使用量合計 {formatBytes(session.storedBytes)}（最大1行{' '}
          {formatBytes(session.maxStoredBytes)}）
        </span>
      </div>
      <div className="mt-1 text-muted-foreground">
        {formatDateTime(session.firstAt)} 〜 {formatDateTime(session.lastAt)}
      </div>
      <TechnicalIds rows={[{ label: '会話の識別子', value: session.sessionId }]} />
    </li>
  );
}

function EntryList() {
  const { data, error, isLoading, isValidating, mutate } = useArchive();

  return (
    <Card>
      <CardHeader
        title="一覧"
        subtitle="新しい順"
        action={data === undefined ? undefined : <Badge>{data.entries.length}</Badge>}
      />
      <LoadError
        what="生ログの一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      {isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : data === undefined ? null : data.entries.length === 0 ? (
        <Empty inset="card">{ARCHIVE_EMPTY}</Empty>
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

// 理由を毎回求めない: 拒まれない大多数の行でも1ステップ増えるため（409 が返ったときだけ理由の入力欄を出す）
const ROW_INTERACTIVE =
  'a, button, input, textarea, select, summary, details, label, [role="dialog"], [role="alertdialog"]';

function EntryRow({ entry }: { entry: ArchiveEntry }) {
  const navigate = useNavigate();
  const removeArchive = useRemoveArchive();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const removed = entry.removedAt !== undefined;
  const denied = failure instanceof ApiError && failure.status === 409;
  const rowName = `${formatDateTime(entry.at)} の会話`;

  const detailPath = `/archive/${encodeURIComponent(entry.id)}`;

  // 行全体を1本の <a> にしない: 行の中にボタンが在り、<a> の中に button は置けないため
  function openDetail(event: MouseEvent<HTMLLIElement>) {
    if (removed) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest(ROW_INTERACTIVE) !== null) return;
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    void navigate(detailPath);
  }

  async function remove(overrideReason?: string) {
    setBusy(true);
    setFailure(undefined);
    try {
      await removeArchive(entry.id, overrideReason);
      // ここで楽観的に表示を変えない: 成功すれば一覧の取り直しで removedAt が付いた行に置き換わるため
      setReason('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={cn(
        'border-b border-border px-4 py-3 text-xs last:border-b-0',
        !removed && 'cursor-pointer transition-colors hover:bg-muted',
      )}
      onClick={openDetail}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{rowName}</span>
        {removed && <Badge tone="warn">本文は削除済み</Badge>}
        {entry.continuity !== undefined && (
          <Badge tone="neutral" title={continuityLabel(entry.continuity)}>
            {continuityLabel(entry.continuity)}
          </Badge>
        )}
      </div>
      <div className="mt-1 text-muted-foreground">使用量 {formatBytes(entry.storedBytes)}</div>
      {!removed && (
        <div className="mt-2">
          <Link to={detailPath} className="underline" aria-label={`${rowName}の本文を読む`}>
            本文を読む
          </Link>
        </div>
      )}
      <TechnicalIds
        rows={[
          { label: '退避の識別子', value: entry.id },
          { label: '会話の識別子', value: entry.sessionId },
        ]}
      />

      {removed ? (
        <div className="mt-1 text-muted-foreground">
          削除: {entry.removedAt === undefined ? '' : formatDateTime(entry.removedAt)}
          {entry.removedBytes !== undefined &&
            `（消した本文は ${formatBytes(entry.removedBytes)}。使用量とは数え方が違うため、空いた容量とは一致しません）`}
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={busy}
              aria-label={`${rowName}の本文を消す`}
              onClick={() => setConfirming(true)}
            >
              本文を消す
            </Button>
            {/* 「理由を付けて消す」に確認を足さない: 理由の入力が前段にあるため */}
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title="退避した会話の本文を消しますか"
              description="本文は空になり、元に戻せません。退避の記録（日時・識別子）は残ります。走行中のマネージャーの退避だった場合は、このあと理由の入力を求めます。"
              confirmLabel="消す"
              destructive
              onConfirm={() => void remove()}
            />
          </div>

          {denied && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                value={reason}
                aria-label="走行中のマネージャーの退避を上書きする理由"
                placeholder="走行中のマネージャーの退避——上書きする理由"
                onChange={(event) => setReason(event.target.value)}
              />
              <Button
                variant="danger"
                size="sm"
                className="shrink-0"
                aria-label={`${rowName}の本文を理由を付けて消す`}
                loading={busy}
                // 理由なしでは override させない: guardArchiveRemoval が非空文字列を意思表示として扱うため
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
