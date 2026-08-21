import { Link } from 'react-router';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useReport, useReports } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime } from '~/lib/format';

import type { DailyReport } from '~/lib/types';

import type { Route } from './+types/reports';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { date: params.date };
}

/**
 * その行が「日報が書けなかった」印か（`packages/core/src/schema.ts` の
 * `unavailable` の doc が正本）。
 *
 * **印の行を日報として描かないため**だけに要る。実際に起きた壊れ方は、日報の
 * 本文が丸ごと `You've hit your org's monthly spend limit …` になっていた、という
 * ものである。いま本文には「（この日の日報は作れなかった…）」が入っているが、
 * **本文の文言で判定しないこと** — 判定は構造化された印で行い、文言は表示に
 * だけ使う（`packages/core/src/sdk-failure.ts` が固定した順序と同じ）。
 *
 * **印の行を一覧から隠さないこと。** 隠すと、人間の側からはその日が「まだ来て
 * いない日」と区別できなくなる。器の側は同じ行を「日報はまだ無い」と数えている
 * （`isWrittenDailyReport`）ので、**人間には見えたまま、機構は書き直せる**という
 * 両立がこの印の存在理由そのものである。
 */
export function isUnavailable(
  report: DailyReport,
): report is DailyReport & { unavailable: string } {
  return typeof report.unavailable === 'string' && report.unavailable !== '';
}

/**
 * 日報の代わりに置かれた印を、**日報ではないと分かる形で**出す。
 *
 * **`Markdown` で描かないこと。** 中身は SDK が出したエラー文であって、クローンが
 * 書いた文章ではない。Markdown として描くと、記法が混ざっていた場合に体裁まで
 * 日報と同じ顔になる。
 *
 * **理由は言い換えずにそのまま出す。** SDK の文言で人間が検索できることが要件
 * である（`usage-limits.ts` の「言い換えないこと」と同じ約束）。
 *
 * **降りる先を名指しする。** 「作れなかった」だけで終わると、その日の記録ごと
 * 失われたと読める。実際には日誌に全部残っており、原因が解ければ本物を書き直せる
 * （印の行は「日報がある」と数えられていないので、その道は閉じていない）。
 */
export function UnavailableNote({ reason }: { reason: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-danger">
        ⚠ <strong className="font-medium">この日の日報は作れなかった</strong>
        。以下はクローンが書いたまとめではなく、書けなかった理由である。
      </p>
      <pre className="mt-2 overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] break-words whitespace-pre-wrap text-muted">
        {reason}
      </pre>
      <p className="mt-2 text-xs text-muted">
        この日の記録は
        <Link to="/journal" className="text-accent hover:underline">
          日誌
        </Link>
        に残っている。書けていないだけなので、原因が解ければ
        <Link to="/schedule" className="text-accent hover:underline">
          スケジュール
        </Link>
        から作り直せる。
      </p>
    </div>
  );
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
                    {/*
                      **印の付いた日は、開く前に分かる形にする。** 一覧では日付しか
                      並ばないので、印を出さないと「日報がある日」と同じ顔になり、
                      人間は開くまで気づけない（本文がエラー文だった穴と同じ形が、
                      一覧の側に残る）。
                    */}
                    {isUnavailable(report) && (
                      <span className="ml-1 text-danger" title="この日の日報は作れなかった">
                        ⚠
                      </span>
                    )}
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
              {isUnavailable(report) ? (
                <UnavailableNote reason={report.unavailable} />
              ) : (
                <Markdown>{report.body}</Markdown>
              )}
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
