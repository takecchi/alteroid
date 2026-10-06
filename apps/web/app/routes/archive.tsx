import { JournalTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { useState } from 'react';
import { Link } from 'react-router';

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
} from '@alteroid/ui';
import { useRemoveArchive, useArchive, useArchiveSessions, ApiError } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { ArchiveEntry, ArchiveSessionSummary } from '@alteroid/logic';

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
 * **本文（生ログ全体）を読む画面は、#776 の時点では足していなかった。** #776 の範囲は
 * 「消す操作を対話面に出す」ことで、行の特定に要る情報（id / sessionId / 時刻 / 使用バイト数 /
 * 削除済みかどうか）は一覧だけで足りる、という判断だった。**#3137 で足した**: PRD の入口の等価性
 * 「見えるもの（日報・日誌・生ログ）は同じ」に照らすと、CLI の `/archive <id>` で読める本文が
 * Web で読めないのは欠落だった。行の「本文を読む」から `archive-detail.tsx`（`/archive/:id`）へ
 * 行く。読むだけで、消す操作は引き続きこの一覧の行にある。
 */
/** 空のときの文言。何が起きるとここに出て、出たあと何ができるかを言う（#2792）。 */
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

/**
 * `sessionId` ごとの集計。CLI の `/archive sessions` と同じもの——
 * 「1本が何度積まれているか」を個々の大きさより先に見せる。
 */
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

/**
 * 直前の退避との関係（core の `ArchiveContinuity`）の利用者向けの言い方。
 * 型で網羅を守る——値が増えたらここが型エラーになる。知らない値は識別子を出さない。
 */
const CONTINUITY_LABELS = {
  first: '最初の退避',
  continues: '前回の続き',
  diverged: '前回と内容が異なる',
  unknown: '前回との関係は不明',
} satisfies Record<NonNullable<ArchiveEntry['continuity']>, string>;

function continuityLabel(value: string): string {
  return (CONTINUITY_LABELS as Record<string, string | undefined>)[value] ?? '前回との関係は不明';
}

/** 識別子（UUID 等）は利用者向けの見出しに出さず、開いた先に置く。 */
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
          使用量合計 {session.storedBytes}バイト（最大1行 {session.maxStoredBytes}バイト）
        </span>
      </div>
      <div className="mt-1 text-muted-foreground">
        {formatDateTime(session.firstAt)} 〜 {formatDateTime(session.lastAt)}
      </div>
      <TechnicalIds rows={[{ label: '会話の識別子', value: session.sessionId }]} />
    </li>
  );
}

/** 一覧本体。行ごとに「本文を消す」を持つ——これが #776 の中心である。 */
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
  // 「本文を消す」の確認を出しているか（押した瞬間には消さない。#3091）。
  // `reason`（理由欄）は別の state なので、確認を開いても閉じても失われない。
  const [confirming, setConfirming] = useState(false);
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
        <span className="font-medium">{formatDateTime(entry.at)} の会話</span>
        {removed && <Badge tone="warn">本文は削除済み</Badge>}
        {entry.continuity !== undefined && (
          <Badge tone="neutral" title={continuityLabel(entry.continuity)}>
            {continuityLabel(entry.continuity)}
          </Badge>
        )}
      </div>
      <div className="mt-1 text-muted-foreground">使用量 {entry.storedBytes}バイト</div>
      {!removed && (
        <div className="mt-2">
          {/* 読むだけの画面（#3137）。消された行は読める本文が無いので出さない。 */}
          <Link to={`/archive/${encodeURIComponent(entry.id)}`} className="underline">
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
            `（消した本文は ${entry.removedBytes}バイト。使用量とは数え方が違うため、空いた容量とは一致しません）`}
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              本文を消す
            </Button>
            {/*
              本文は戻せない（#3091）。`stores.archive.remove` は fs では本体の `.jsonl` を空へ
              切り詰め、pg では `body` を `''` に更新する。復元の口は無く、日誌に残るのは
              id とバイト数だけである。「理由を付けて消す」は、理由の入力が前段なので
              確認を足さない（#3091）。
            */}
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
