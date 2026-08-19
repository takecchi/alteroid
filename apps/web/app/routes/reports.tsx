import { Link } from 'react-router';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useReport, useReports } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime } from '~/lib/format';

import type { Route } from './+types/reports';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { date: params.date };
}

export default function Reports({ loaderData }: Route.ComponentProps) {
  const { date } = loaderData;
  const list = useReports(60);

  const reports = list.data?.reports ?? [];
  // 日付の指定が無ければ最新を出す。空の画面から始めない。
  const selected = date ?? reports[0]?.date;

  return (
    <Page title="日報" description="普段の接点はほぼこれだけでよい。掘りたくなったら日誌へ降りる">
      <ErrorNote error={list.error} className="mb-4" />

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          {list.isLoading ? (
            <Spinner />
          ) : reports.length === 0 ? (
            <Empty>まだ無い。</Empty>
          ) : (
            <ul>
              {reports.map((report) => (
                <li key={report.id}>
                  <Link
                    to={`/reports/${report.date}`}
                    className={cn(
                      'block border-b border-border px-4 py-2 text-sm hover:bg-surface-2',
                      report.date === selected && 'bg-surface-2 text-accent',
                    )}
                  >
                    {report.date}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selected === undefined ? (
          <Card>
            <Empty>
              日報が1件も無い。クローンが締め時刻にまとめる（スケジュールから今すぐ回せる）。
            </Empty>
          </Card>
        ) : (
          <ReportBody date={selected} />
        )}
      </div>
    </Page>
  );
}

function ReportBody({ date }: { date: string }) {
  const { data, error, isLoading } = useReport(date);

  return (
    <Card className="min-w-0">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{date}</h2>
      </div>
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : data === undefined || data.reports.length === 0 ? (
        <Empty>この日の日報は無い。</Empty>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {/*
            同じ日に複数あることがある（起動時の遡り生成と、その日の締め）。
            片方だけ出すと「書き換わった」ように見えるので、全部並べる。
          */}
          {data.reports.map((report) => (
            <article key={report.id} className="min-w-0 px-4 py-3">
              <p className="mb-2 text-[11px] text-muted">{formatDateTime(report.at)}</p>
              <Markdown>{report.body}</Markdown>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
