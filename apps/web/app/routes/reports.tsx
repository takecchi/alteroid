import { useId } from 'react';
import { Link } from 'react-router';

import { LoadError } from '~/components/load-error';
import {
  markdownComponents,
  toReact,
  Page,
  ListDetail,
  ListDetailItems,
  Button,
  Empty,
  Spinner,
  cn,
} from '@alteroid/ui';
import { useReport, useReportsWindow } from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';

import type { DailyReport } from '@alteroid/logic';

import type { Route } from './+types/reports';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { date: params.date, reportId: params.reportId };
}

// 本文の文言で判定しない: 判定は構造化された印で行い、文言は表示にだけ使うため
// 印の行を一覧から隠さない: 隠すと人間の側からはその日が「まだ来ていない日」と区別できないため
export function isUnavailable(
  report: DailyReport,
): report is DailyReport & { unavailable: string } {
  return typeof report.unavailable === 'string' && report.unavailable !== '';
}

// Markdown で描かない: 中身は SDK が出したエラー文であって、クローンが書いた文章ではなく、記法が混ざると体裁まで日報と同じ顔になるため
// 理由は言い換えずにそのまま出す: SDK の文言で人間が検索できることが要件のため
export function UnavailableNote({ reason }: { reason: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-destructive">
        ⚠ <strong className="font-medium">この日の日報は作れなかった</strong>
        。以下はクローンが書いたまとめではなく、書けなかった理由である。
      </p>
      <pre className="mt-2 overflow-x-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
        {reason}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">
        この日の記録は
        <Link to="/journal" className="text-primary hover:underline">
          日誌
        </Link>
        に残っている。書けていないだけなので、原因が解ければ
        <Link to="/schedule" className="text-primary hover:underline">
          スケジュール
        </Link>
        から作り直せる。
      </p>
    </div>
  );
}

// 日の部分を at から導かない: 遡り生成では前日ぶんの日報が今日書かれ、隣の日報と同じ日付に見えて見分けが付かなくなるため
function reportTitle(date: string): string {
  return `${date} の日報`;
}

// 日付つきで出す: 時:分だけだと翌日に書かれた1件が日報の日の 00:30 に書かれたように読めるため
function writtenAt(report: DailyReport): string {
  return `${formatDateTime(report.at)} に書かれた`;
}

// 本文の見出しを1段下げる: 画面の見出し（h1）・カードの見出し（h2）の下に本文の # が h1 で並ばないようにするため
const reportMarkdownComponents: typeof markdownComponents = {
  ...markdownComponents,
  h1: markdownComponents.h3,
  h2: markdownComponents.h4,
  h3: markdownComponents.h5,
  h4: markdownComponents.h6,
  h5: markdownComponents.h6,
  h6: markdownComponents.h6,
};

function ReportMarkdown({ children }: { children: string }) {
  const prefix = 'md' + useId().replace(/[^A-Za-z0-9_-]/g, '') + '-';
  return (
    <div className="min-w-0 text-sm break-words">
      {toReact(children, reportMarkdownComponents, prefix)}
    </div>
  );
}

// limit 件ちょうど返ったときだけ「もっと古い日報を読む」を出す: GET /reports は総件数を返さず、続きが在るかは limit 件ちょうど返ったかで判るため
const REPORTS_LIMIT = 60;

export default function Reports({ loaderData }: Route.ComponentProps) {
  const { date, reportId } = loaderData;
  const {
    first: list,
    reports,
    hasMore,
    isLoadingOlder,
    olderError,
    loadOlder,
  } = useReportsWindow(REPORTS_LIMIT);

  // 並べ直さない: 並びはデーモンが決め、ここで並べ直すと「最新の日報」が CLI・クローンとこの画面で食い違うため
  const selectedDate = date ?? reports[0]?.date;
  // 選択を date で決めない: 同じ日に複数あり、date だけで選ぶとその日の全部が選択中になり本文にも全部が並ぶため
  const selectedId = reportId ?? reports.find((report) => report.date === selectedDate)?.id;
  // 取れなかったのを0件と描かない: 一覧の「まだ無い」も右の「日報が1件も無い」も一覧が空であることに乗っているため
  const listUnavailable = list.data === undefined && list.error !== undefined;

  const hrefOf = (report: DailyReport) =>
    `/reports/${report.date}/${encodeURIComponent(report.id)}`;
  const sameDayAsNext = new Set<string>();
  const latestOfManyInDay = new Set<string>();
  reports.forEach((report, index) => {
    const sameAsNext = reports[index + 1]?.date === report.date;
    if (sameAsNext) sameDayAsNext.add(hrefOf(report));
    if (sameAsNext && reports[index - 1]?.date !== report.date) {
      latestOfManyInDay.add(hrefOf(report));
    }
  });

  return (
    <Page
      title="日報"
      description="普段の接点はほぼこれだけでよい。掘りたくなったら日誌へ降りる"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        <LoadError
          what="日報の一覧"
          error={list.error}
          onRetry={() => list.mutate()}
          retrying={list.isValidating}
          className="mx-4 mt-4 shrink-0 md:mx-6"
        />
        <ListDetail
          className="min-h-0 flex-1"
          listLabel="日報の一覧"
          hasSelection={selectedDate !== undefined}
          selectionKey={selectedId}
          list={
            list.isLoading ? (
              <Spinner />
            ) : listUnavailable ? null : reports.length === 0 ? (
              <Empty>まだ無い。</Empty>
            ) : (
              <ListDetailItems
                label="日報"
                items={reports.map((report) => ({
                  key: report.id,
                  href: hrefOf(report),
                  current: report.id === selectedId,
                  children: (
                    <>
                      <span className="block">{reportTitle(report.date)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {writtenAt(report)}
                        {latestOfManyInDay.has(hrefOf(report)) && (
                          <span className="ml-1 rounded border border-border px-1 text-[11px]">
                            最新
                          </span>
                        )}
                      </span>
                      {/* 印の付いた行は開く前に分かる形にする: 印を出さないと「日報がある行」と同じ顔になり、人間は開くまで気づけないため */}
                      {isUnavailable(report) && (
                        <span className="ml-1 text-destructive" title="この日の日報は作れなかった">
                          ⚠
                        </span>
                      )}
                    </>
                  ),
                }))}
                renderLink={({ href, className, children, ...rest }) => (
                  <Link
                    to={href}
                    {...rest}
                    className={cn(
                      className,
                      /* 罫線は日付の変わり目にだけ引く: 「同じ日の行が隣り合っている」という並びの保証に乗っているため */
                      sameDayAsNext.has(href) && 'border-b-0',
                    )}
                  >
                    {children}
                  </Link>
                )}
              />
            )
          }
          listFooter={
            hasMore || olderError !== undefined ? (
              <div className="flex flex-col gap-2 px-4 py-2">
                <LoadError
                  what="もっと古い日報"
                  error={olderError}
                  onRetry={loadOlder}
                  retrying={isLoadingOlder}
                />
                {hasMore && (
                  <>
                    <p className="text-[11px] text-muted-foreground">
                      いま読んでいるのは {reports.length}{' '}
                      件ぶん。これより古い日報があるかもしれない。
                    </p>
                    <Button
                      variant="default"
                      size="sm"
                      loading={isLoadingOlder}
                      onClick={loadOlder}
                    >
                      もっと古い日報を読む
                    </Button>
                  </>
                )}
              </div>
            ) : undefined
          }
          emptyDetail={
            listUnavailable ? null : list.isLoading ? (
              /* 読み込み中に「1件も無い」と言わない: 一覧がまだ来ていないだけで selectedDate が無く、「無い」と区別できないため */
              <Spinner />
            ) : (
              <Empty>
                日報が1件も無い。クローンが締め時刻にまとめる（スケジュールから今すぐ回せる）。
              </Empty>
            )
          }
          detail={
            selectedDate === undefined ? null : (
              <ReportBody date={selectedDate} reportId={selectedId} />
            )
          }
        />
      </div>
    </Page>
  );
}

function ReportBody({ date, reportId }: { date: string; reportId: string | undefined }) {
  const { data, error, isLoading, isValidating, mutate } = useReport(date);

  const reports = data?.reports ?? [];
  // 同じ日の全部を縦に並べない: 同じ日の項目が見分けられず、どれを選んでも2件が同時に開いて読みにくかったため
  const report = reports.find((entry) => entry.id === reportId) ?? reports[0];
  // 取れなかったのを「この日の日報は無い」と描かない: 失敗は上の LoadError が言うため
  const bodyUnavailable = data === undefined && error !== undefined;

  return (
    <div className="min-w-0">
      <div className="border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{reportTitle(date)}</h2>
      </div>
      <LoadError
        what="この日の日報"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="my-3"
      />
      {isLoading ? (
        <Spinner />
      ) : bodyUnavailable ? null : report === undefined ? (
        <Empty>この日の日報は無い。</Empty>
      ) : (
        <article className="min-w-0 pt-3">
          {/* 「書かれたのは」を省かない: 遡り生成では見出しの日と at の日が食い違い、裸の時刻だと見出しと矛盾して見えるため */}
          <p className="mb-2 text-[11px] text-muted-foreground">
            書かれたのは {formatDateTime(report.at)}
          </p>
          {isUnavailable(report) ? (
            <UnavailableNote reason={report.unavailable} />
          ) : (
            <ReportMarkdown>{redactBody(report.body)}</ReportMarkdown>
          )}
        </article>
      )}
    </div>
  );
}
