import { ScheduleTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Page, Badge, Button, Card, CardHeader, ErrorNote, Input } from '@alteroid/ui';
import { useInboxBacklog, useInboxRemoveMany } from '@alteroid/swr';
import {
  INBOX_TYPES,
  formatDateTime,
  inboxSourceLabel,
  inboxTypeLabel,
  localDateTimeToIso,
} from '@alteroid/logic';
import type {
  InboxBacklog,
  InboxEventType,
  InboxRemoveManyResult,
  UnreadableInboxEvent,
} from '@alteroid/logic';

// 7種類のうち2つを外さない: 人間の入口だけ能力が落ちるため（クローンの道具 inbox_remove_many の線引きはこの HTTP の口の線引きではない）
// 確認ダイアログを置かない: 「試算する→結果を見る→実行する」の2段構えが先に対象を見せており、重ねると同じ確認を二重に求めるため
// 値を @alteroid/core から import しない: apps/web は core の値 import を禁じているため
export default function Inbox() {
  return (
    <Page
      tabs={<ScheduleTabs />}
      title="受信箱"
      description="まだ処理し終えていない合図を、絞り込んでまとめて消す。まず試算でき、試算では1件も消さない"
    >
      <LeaveGuardScope>
        <div className="flex flex-col gap-4">
          <InboxBacklogCard />
          <InboxRemoveCard />
        </div>
      </LeaveGuardScope>
    </Page>
  );
}

const INBOX_TYPE_ORDER = INBOX_TYPES;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// 集計をやり直さない: 集計は core の summarizeInboxBacklog 1箇所のため
function InboxBacklogCard() {
  const { data, error, isLoading, isValidating, mutate } = useInboxBacklog();

  return (
    <Card>
      <CardHeader
        title="内訳"
        subtitle="いま溜まっている合図の数え方（見るだけで、何も変わらない）"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <LoadError
          what="受信箱の内訳"
          error={error}
          onRetry={() => mutate()}
          retrying={isValidating}
        />
        {isLoading && data === undefined && (
          <p className="text-xs text-muted-foreground">読み込み中…</p>
        )}
        {data !== undefined && <InboxBacklogView backlog={data} />}
      </div>
    </Card>
  );
}

// 「処理済みで消えたのではない」を落とさない: 落とすと、行が消えたのと区別が付かないため
const UNREADABLE_INBOX_IDS_SHOWN = 20;

function UnreadableInboxNote({ unreadable }: { unreadable: UnreadableInboxEvent[] }) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_INBOX_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない合図が {unreadable.length} 件ある
        {ids.length > 0 &&
          `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
        。<strong>壊れた行であって、処理済みで消えたのではない。</strong>
        下の内訳には載っていない。配られてもいない。
      </span>
    </div>
  );
}

function InboxBacklogView({ backlog }: { backlog: InboxBacklog }) {
  const unreadable = backlog.unreadable ?? [];
  if (backlog.total === 0) {
    if (unreadable.length > 0) {
      return (
        <div className="flex flex-col gap-3">
          <UnreadableInboxNote unreadable={unreadable} />
          <p className="text-xs text-muted-foreground">読めた未処理の合図は無い。</p>
        </div>
      );
    }
    return <p className="text-xs text-muted-foreground">クローンの受信箱に未処理の合図は無い。</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <UnreadableInboxNote unreadable={unreadable} />
      {backlog.humanOriginated.total > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <p>
            ⚠ 人間からの合図（発言・回答）が溜まっている: {backlog.humanOriginated.total} 件（
            {backlog.humanOriginated.byType
              .map((entry) => `${inboxTypeLabel(entry.type)} ${entry.count}`)
              .join(' / ')}
            ）。
          </p>
          <p>
            そのうち、いまの器になってから溜まり、まだ片付いていない分が{' '}
            {backlog.humanOriginated.undelivered} 件（残っている行を数えているだけで、
            まだ処理されていないとは言い切れない）。
          </p>
        </div>
      )}

      <p className="text-xs">
        計 {backlog.total} 件
        {backlog.oldestAt !== undefined &&
          ` （最も古いものは ${formatDateTime(backlog.oldestAt)} から）`}
      </p>

      <BreakdownSection
        title="種類"
        rows={backlog.byType.map((entry) => ({
          label: inboxTypeLabel(entry.type),
          count: entry.count,
        }))}
      />

      <BreakdownSection
        title={`送信元（多い順に上位5件。送り主が分かる種類のみ。載り切らない送信元 ${backlog.bySourceOverflowKinds} 種 ${backlog.bySourceOverflowCount} 件 / 送り主が分からない種類 ${backlog.bySourceUnknownCount} 件）`}
        rows={backlog.bySource.map((entry) => ({
          label: inboxSourceLabel(entry.source),
          count: entry.count,
        }))}
        empty="（送り主が分かる種類の合図は無い）"
      />

      <p className="text-xs">
        同じ内容の合図（id と時刻を除く）をまとめると {backlog.distinct} 件
        {backlog.distinctAcrossManagers !== backlog.distinct &&
          ` ／ 同じ内容がマネージャーをまたいで ${backlog.distinctAcrossManagers} 件`}
        <span className="block text-muted-foreground">
          ⚠ 内容が同じでも別々に起きた出来事である。この数は上下どちらへもぶれる。
        </span>
      </p>

      <p className="text-xs">
        器の入れ替え回数: 0回＝いまの器になってから溜まった {backlog.undelivered} / 1回{' '}
        {backlog.deliveredOnce} / 2回以上 {backlog.redelivered}（最大 {backlog.maxDeliveries}）
        <span className="block text-muted-foreground">
          ⚠ 処理した回数ではない — 処理されないまま数だけ増えることもある
        </span>
      </p>

      <BreakdownSection
        title="いまの器になってから溜まった分（0回）の内訳（種類別）"
        rows={backlog.undeliveredByType.map((entry) => ({
          label: inboxTypeLabel(entry.type),
          count: entry.count,
        }))}
      />

      <BreakdownSection
        title={`溜まっている時間（${formatDateTime(backlog.observedAt)} 時点）`}
        rows={backlog.ageBuckets.map((entry) => ({ label: entry.label, count: entry.count }))}
      />
    </div>
  );
}

function BreakdownSection({
  title,
  rows,
  empty = '（無し）',
}: {
  title: string;
  rows: { label: string; count: number }[];
  empty?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs">{empty}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-2">
              <span className="font-mono break-all">{row.label}</span>
              <span className="shrink-0">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxRemoveCard() {
  const removeMany = useInboxRemoveMany();

  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<InboxEventType>>(new Set());
  const [sourcesText, setSourcesText] = useState('');
  const [beforeText, setBeforeText] = useState('');
  const [reason, setReason] = useState('');
  const [limitText, setLimitText] = useState('');

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [result, setResult] = useState<InboxRemoveManyResult | null>(null);
  const executed = result !== null && !result.dryRun;
  useReportDirty(
    'inbox-remove',
    !executed &&
      (selectedTypes.size > 0 ||
        [sourcesText, beforeText, reason, limitText].some((field) => field !== '')),
  );

  const types = useMemo(
    () => INBOX_TYPE_ORDER.filter((type) => selectedTypes.has(type)),
    [selectedTypes],
  );
  const sources = useMemo(() => splitList(sourcesText), [sourcesText]);
  const before = localDateTimeToIso(beforeText);
  const limitTrimmed = limitText.trim();
  const limitNumber = Number(limitTrimmed);
  const limitValid = limitTrimmed === '' || (Number.isInteger(limitNumber) && limitNumber >= 1);
  const limit = limitTrimmed === '' || !limitValid ? undefined : limitNumber;

  const allSelected = types.length === INBOX_TYPE_ORDER.length;
  // 7種類すべてでは送らない: サーバが 400 で断り、その本文は欄名と識別子で持ち主の読む言葉ではないため
  const canRun = types.length > 0 && !allSelected && reason.trim() !== '' && limitValid && !busy;

  // 絞り込みを変えたときだけ呼ぶ（reason の変更では呼ばない）: 呼ばないと古い件数のまま「実行する」を押せてしまうため
  function invalidatePreviousResult() {
    setResult(null);
    setFailure(undefined);
  }

  function toggleType(type: InboxEventType) {
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
    invalidatePreviousResult();
  }

  async function runDryRun() {
    if (!canRun) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const response = await removeMany({
        types,
        sources: sources.length === 0 ? undefined : sources,
        before,
        reason: reason.trim(),
        limit,
        dryRun: true,
      });
      setResult(response);
    } catch (caught) {
      setResult(null);
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  async function runExecute() {
    if (result === null || !result.dryRun || !canRun) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const response = await removeMany({
        types,
        sources: sources.length === 0 ? undefined : sources,
        before,
        reason: reason.trim(),
        limit,
        dryRun: false,
      });
      setResult(response);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="絞り込み" subtitle="消す合図の条件を選ぶ" />
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">種類（最低1つ）</p>
          <div className="flex flex-col gap-1">
            {INBOX_TYPE_ORDER.map((type) => (
              <label key={type} className="flex items-center gap-2 text-xs pointer-coarse:min-h-11">
                <input
                  type="checkbox"
                  className="pointer-coarse:size-5"
                  checked={selectedTypes.has(type)}
                  onChange={() => toggleType(type)}
                />
                <span>{inboxTypeLabel(type)}</span>
              </label>
            ))}
          </div>
          <AllSelectedWarning show={allSelected} />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            送信元（完全一致・カンマ区切り。外部の通知は external:名前、マネージャーは manager:名前
            の形。任意）
          </span>
          <Input
            value={sourcesText}
            onChange={(event) => {
              setSourcesText(event.target.value);
              invalidatePreviousResult();
            }}
            placeholder="任意"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            この日時より古い合図だけを対象にする（任意）
          </span>
          <Input
            type="datetime-local"
            value={beforeText}
            onChange={(event) => {
              setBeforeText(event.target.value);
              invalidatePreviousResult();
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">理由（日誌に残る・必須）</span>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            1回で消す上限（任意。省略時はサーバの既定）
          </span>
          <Input
            value={limitText}
            onChange={(event) => {
              setLimitText(event.target.value);
              invalidatePreviousResult();
            }}
            placeholder="例 500"
          />
          {!limitValid && <span className="text-xs text-destructive">1以上の整数を入れること</span>}
        </label>

        <ErrorNote error={failure} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canRun}
            loading={busy}
            onClick={() => void runDryRun()}
          >
            試算する
          </Button>
          {result !== null && result.dryRun && (
            <Button
              variant="danger"
              size="sm"
              disabled={!canRun}
              loading={busy}
              onClick={() => void runExecute()}
            >
              実行する（対象 {result.targeted} 件を消す）
            </Button>
          )}
        </div>

        {result !== null && <ResultView result={result} />}
      </div>
    </Card>
  );
}

function AllSelectedWarning({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="mt-2 text-xs text-warn">
      7種類すべてを選んでいる。これは「絞り込みが無い」のと同じなので、試算も実行もできない
      （1回で受信箱を空にできてしまうのを防ぐため。全部消したいときは「設定」画面の
      ワークスペースのリセットを使う）。消したい種類だけを選ぶこと。
    </p>
  );
}

function ResultView({ result }: { result: InboxRemoveManyResult }) {
  return (
    <div className="rounded-md border border-border bg-muted p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge tone={result.dryRun ? 'warn' : 'ok'}>{result.dryRun ? '試算' : '実行済み'}</Badge>
      </div>
      <p className="mt-2">
        未読 {result.totalPending} 件中 {result.matched} 件が絞り込みに一致（対象 {result.targeted}{' '}
        件、上限で持ち越し {result.remaining} 件）
      </p>
      {result.dryRun ? (
        <p className="mt-2 text-muted-foreground">
          1件も消していません（試算）。この内容でよければ「実行する」を押してください。
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground">
          実行しました。消した id は日誌にも残っています。
        </p>
      )}
      {result.removedIds.length === 0 ? (
        <p className="mt-2 text-muted-foreground">対象になる合図は無い。</p>
      ) : (
        <>
          <p className="mt-2">
            {result.dryRun ? '消える予定の合図の id' : '消した合図の id'}（
            {result.removedIds.length}件）:
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono break-all">
            {result.removedIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
