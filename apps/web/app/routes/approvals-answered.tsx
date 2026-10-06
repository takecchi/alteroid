import { Link } from 'react-router';

import { ApprovalEntry } from '~/components/approval-entry';
import { ApprovalsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import {
  Page,
  ListDetail,
  ListDetailItems,
  AnsweredApprovalRow,
  Empty,
  Spinner,
  cn,
} from '@alteroid/ui';
import { useAnsweredApprovalDates, useApprovalsAnsweredOn } from '@alteroid/swr';
import { formatDateTime, formatRelative, redactBody } from '@alteroid/logic';
import type { AnsweredApprovalDate, PendingApproval } from '@alteroid/logic';

import type { Route } from './+types/approvals-answered';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { date: params.date, approvalId: params.approvalId };
}

/**
 * 左の目次に読む日数。**窓の大きさは日報（`reports.tsx` の `REPORTS_LIMIT`）と同じ 60。**
 * `GET /approvals/answered-dates` は総数を返さない（`GET /reports` と同じ。続きが在るかは
 * `limit` 件ちょうど返ったかで判る）ので、ちょうど一致したときだけ「これより古い日が
 * あるかもしれない」と言う——黙って切り捨てない。
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
export default function ApprovalsAnswered({ loaderData }: Route.ComponentProps) {
  const { date, approvalId } = loaderData;
  const list = useAnsweredApprovalDates(DATES_LIMIT);

  /**
   * 形の違う応答（`dates` が配列でない）は「0件」ではなく「読めていない」へ倒す（#2308 と同じ。
   * デーモンと画面は別デプロイで版がずれうる）。
   */
  const dates: AnsweredApprovalDate[] = Array.isArray(list.data?.dates) ? list.data.dates : [];
  const datesMalformed = list.data !== undefined && !Array.isArray(list.data.dates);
  const selectedDate = date ?? dates[0]?.date;
  /** 一覧をまだ一度も読めていないまま失敗した。失敗は上の `LoadError` が言う。 */
  const listUnavailable = (list.data === undefined && list.error !== undefined) || datesMalformed;

  return (
    // 余白とスクロールは外す（`ListDetail` が左右のペインをそれぞれスクロールさせる。`reports.tsx` と同じ）。
    <Page
      tabs={<ApprovalsTabs />}
      title="回答済みの承認"
      description="答えた・取り下げた承認を、決着した日ごとに読む。日付の区切りは日報と同じ"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
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
            dates.length === DATES_LIMIT ? (
              <p className="px-4 py-2 text-[11px] text-muted-foreground">
                直近 {DATES_LIMIT} 日のみ表示している。これより古い日があるかもしれない。
              </p>
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
                  {formatRelative(settledAt(selected)!)}）
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
