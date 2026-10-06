import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router';

import { ApprovalEntry } from '~/components/approval-entry';
import { ApprovalsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { useMinuteNow } from '~/lib/use-now';
import {
  Button,
  Page,
  ListDetail,
  ListDetailItems,
  AnsweredApprovalRow,
  Empty,
  Spinner,
  cn,
} from '@alteroid/ui';
import { useAnsweredDatesWindow, useApprovals, useApprovalsAnsweredOn } from '@alteroid/swr';
import { formatDateTime, formatRelative, redactBody } from '@alteroid/logic';
import type { PendingApproval } from '@alteroid/logic';

import type { Route } from './+types/approvals-answered';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { date: params.date, approvalId: params.approvalId };
}

/**
 * 左の目次に1回で読む日数（最初の頁も「もっと古い日を読む」の1頁も同じ）。
 * `GET /approvals/answered-dates` は総数を返さない（`GET /reports` と同じ。続きが在るかは
 * `limit` 件ちょうど返ったかで判る）ので、ちょうど一致したときだけ「もっと古い日を読む」を出す。
 * 読み足しは `useAnsweredDatesWindow`（`beforeDate` で続きを読み、いまの一覧の後ろへ足す）。
 */
const DATES_LIMIT = 60;

/** 決着の日時。デーモンの日の区切り（`answeredAt`、無ければ `withdrawnAt`）と同じ決め方。 */
function settledAt(approval: PendingApproval): string | undefined {
  return approval.answeredAt ?? approval.withdrawnAt ?? undefined;
}

const dayHref = (date: string) => `/approvals/answered/${date}`;
const approvalHref = (date: string, id: string) => `${dayHref(date)}/${encodeURIComponent(id)}`;

/**
 * 回答済みの承認（回答済み・取り下げ済み）を日ごとに読むページ。日報（`reports.tsx`）と同じ形——
 * 左に「決着した日と件数」、右にその日の件、1件を選ぶと詳細。
 *
 * - **日はデーモンの `localDate()`（日報と同じ区切り）で決まる。** 行の時刻だけは閲覧者の端末の
 *   時間帯で出す（`formatDateTime`）ので、端末とデーモンの時間帯が違うと、日の境目の件は
 *   「日付」と「時刻」の日が食い違って見えうる（日報の `date` と `at` と同じ）
 * - 日付の指定が無ければ最新の日を開く（日報と同じ。空の画面から始めない）
 * - 並びはデーモンが決める（目次は新しい日が上・件は決着の新しい順）。**ここで並べ直さない**
 * - 取れなかったのを0件と描かない（#2324 と同じ。目次・その日の件の両方）
 */
/**
 * 読めない承認待ちの案内（#3297）。**回答済みの指定では、デーモンは `unreadable` を載せない**
 * （決着の日時も分からず、どの日にも置けない）ので、未回答の側の一覧から件数を取って1行だけ言う。
 * 件数は `/approvals` の警告・ナビの札と同じ `useApprovals(true)` の `unreadable`。
 *
 * **取れなかったのを0件と描かない。** 読み込み中・失敗・形違いのときは何も出さない
 * （「読めない承認は無い」とも言わない。SWR は失敗しても古い `data` を残すので、失敗を先に見る）。
 */
function UnreadableApprovalsPointer() {
  const { data, error } = useApprovals(true);
  if (error !== undefined || !Array.isArray(data?.unreadable) || data.unreadable.length === 0) {
    return null;
  }
  return (
    <div
      role="status"
      className="mx-4 mt-4 flex shrink-0 items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn md:mx-6"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない承認待ちが {data.unreadable.length} 件ある（
        <Link to="/approvals" className="underline">
          未回答のページで見る
        </Link>
        ）。壊れた行であって、回答済みでも取り下げ済みでもないので、この一覧には載らない。
      </span>
    </div>
  );
}

export default function ApprovalsAnswered({ loaderData }: Route.ComponentProps) {
  const { date, approvalId } = loaderData;
  const {
    first: list,
    dates,
    hasMore,
    isLoadingOlder,
    olderError,
    loadOlder,
  } = useAnsweredDatesWindow(DATES_LIMIT);

  /**
   * 形の違う応答（`dates` が配列でない）は「0件」ではなく「読めていない」へ倒す（#2308 と同じ。
   * デーモンと画面は別デプロイで版がずれうる）。
   */
  const datesMalformed = list.data !== undefined && !Array.isArray(list.data.dates);
  const selectedDate = date ?? dates[0]?.date;
  /** 一覧をまだ一度も読めていないまま失敗した。失敗は上の `LoadError` が言う。 */
  const listUnavailable = (list.data === undefined && list.error !== undefined) || datesMalformed;
  /**
   * URL で開いた日が、読み込んだ範囲に載っていない（もっと古い日か、その日に決着した承認が無い）。
   * その日の件は右に出る（`DayBody` は目次と独立に取る）。左で「今ここ」を示せないので、そう言う。
   * 日報（`reports.tsx`）は黙って選択無しにしている。
   */
  const selectedOutsideList =
    date !== undefined &&
    !listUnavailable &&
    !list.isLoading &&
    !dates.some((entry) => entry.date === date);

  return (
    // 余白とスクロールは外す（`ListDetail` が左右のペインをそれぞれスクロールさせる。`reports.tsx` と同じ）。
    <Page
      tabs={<ApprovalsTabs />}
      title="回答済みの承認"
      description="答えた・取り下げた承認を、決着した日ごとに読む。日付の区切りは日報と同じ"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        <UnreadableApprovalsPointer />
        <LoadError
          what="承認の日付の一覧"
          error={datesMalformed ? new Error('日付の一覧が読めない形で届いた') : list.error}
          onRetry={() => list.mutate()}
          retrying={list.isValidating}
          className="mx-4 mt-4 shrink-0 md:mx-6"
        />
        <ListDetail
          className="min-h-0 flex-1"
          listLabel="決着した日"
          hasSelection={selectedDate !== undefined}
          selectionKey={approvalId ?? selectedDate}
          list={
            list.isLoading ? (
              <Spinner />
            ) : listUnavailable ? null : dates.length === 0 ? (
              <Empty>まだ無い。</Empty>
            ) : (
              <ListDetailItems
                label="決着した日"
                items={dates.map((entry) => ({
                  key: entry.date,
                  href: dayHref(entry.date),
                  current: entry.date === selectedDate,
                  children: (
                    <>
                      <span className="block">{entry.date}</span>
                      <span className="block text-xs text-muted-foreground">{entry.count} 件</span>
                    </>
                  ),
                }))}
                renderLink={({ href, className, children, ...rest }) => (
                  <Link to={href} {...rest} className={className}>
                    {children}
                  </Link>
                )}
              />
            )
          }
          listFooter={
            selectedOutsideList || hasMore || olderError !== undefined ? (
              <div className="flex flex-col gap-2 px-4 py-2">
                {selectedOutsideList && (
                  <p className="text-[11px] text-muted-foreground">
                    開いている {date} は、この目次に読み込んだ日の中に無い（もっと古い日か、その日に
                    決着した承認が無い）。
                  </p>
                )}
                <LoadError
                  what="もっと古い日"
                  error={olderError}
                  onRetry={loadOlder}
                  retrying={isLoadingOlder}
                />
                {hasMore && (
                  <>
                    <p className="text-[11px] text-muted-foreground">
                      いま読んでいるのは {dates.length} 日ぶん。これより古い日があるかもしれない。
                    </p>
                    <Button
                      variant="default"
                      size="sm"
                      loading={isLoadingOlder}
                      onClick={loadOlder}
                    >
                      もっと古い日を読む
                    </Button>
                  </>
                )}
              </div>
            ) : undefined
          }
          emptyDetail={
            listUnavailable ? null : list.isLoading ? (
              // 読み込み中に「1件も無い」と言わない（日報と同じ）。
              <Spinner />
            ) : (
              <Empty>回答済みの承認はまだ無い。</Empty>
            )
          }
          detail={
            selectedDate === undefined ? null : (
              <DayBody date={selectedDate} approvalId={approvalId} />
            )
          }
        />
      </div>
    </Page>
  );
}

/** 右のペイン。`approvalId` が無ければその日の件の一覧、在ればその1件の詳細。 */
function DayBody({ date, approvalId }: { date: string; approvalId: string | undefined }) {
  const { data, error, isLoading, isValidating, mutate } = useApprovalsAnsweredOn(date);
  // 「決着したのは …（N分前）」を古いまま残さない（#3700。#3596 と同じ形）。
  const now = useMinuteNow();

  const approvals: PendingApproval[] | undefined = Array.isArray(data?.approvals)
    ? data.approvals
    : undefined;
  const malformed = data !== undefined && approvals === undefined;
  /** 本文をまだ一度も読めていないまま失敗した（再検証の失敗で `data` が残っているときは当たらない）。 */
  const unavailable = data === undefined && error !== undefined;

  const selected =
    approvalId === undefined ? undefined : approvals?.find((entry) => entry.id === approvalId);

  return (
    <div className="min-w-0">
      <div className="border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{date} に決着した承認</h2>
        {approvals !== undefined && approvalId === undefined && (
          <p className="mt-1 text-xs text-muted-foreground">
            {approvals.length} 件（決着の新しい順）
          </p>
        )}
      </div>
      <LoadError
        what="この日の承認"
        error={malformed ? new Error('この日の承認の一覧が読めない形で届いた') : error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="my-3"
      />
      {isLoading ? (
        <Spinner />
      ) : unavailable || malformed || approvals === undefined ? null : approvalId === undefined ? (
        approvals.length === 0 ? (
          <Empty>この日に決着した承認は無い。</Empty>
        ) : (
          <ul className="mt-3 flex flex-col gap-2" aria-label={`${date} に決着した承認`}>
            {approvals.map((approval) => {
              const at = settledAt(approval);
              return (
                <li key={approval.id}>
                  <AnsweredApprovalRow
                    state={
                      approval.withdrawnAt != null && approval.answeredAt == null
                        ? 'withdrawn'
                        : 'answered'
                    }
                    time={at === undefined ? '' : formatDateTime(at)}
                    question={redactBody(approval.question)}
                    {...(approval.answer != null ? { answer: redactBody(approval.answer) } : {})}
                    {...(approval.withdrawnReason != null
                      ? { withdrawnReason: redactBody(approval.withdrawnReason) }
                      : {})}
                    renderLink={({ className, children }) => (
                      <Link to={approvalHref(date, approval.id)} className={className}>
                        {children}
                      </Link>
                    )}
                  />
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <div className="pt-3">
          <Link
            to={dayHref(date)}
            className={cn('mb-3 inline-block text-xs text-primary hover:underline')}
          >
            ← {date} の一覧へ
          </Link>
          {selected === undefined ? (
            // 古い URL・別の日の id。「無い」と言い切らず、見た日を名指しして一覧へ戻す。
            <Empty>{date} に決着した承認の中に、この件は見つからない。</Empty>
          ) : (
            <>
              {settledAt(selected) !== undefined && (
                <p className="mb-2 text-[11px] text-muted-foreground">
                  決着したのは {formatDateTime(settledAt(selected)!)}（
                  {formatRelative(settledAt(selected)!, now)}）
                </p>
              )}
              <ApprovalEntry approval={selected} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
