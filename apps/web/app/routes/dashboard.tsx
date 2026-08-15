import { formatUsd, summarizeUsage, usageDate } from '@alteroid/core/usage';
import { Link } from 'react-router';

import { Page } from '~/components/page';
import { Badge, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import {
  summarizeJournalEntry,
  useApprovals,
  useManagers,
  useReports,
  useSchedule,
  useUsage,
} from '~/hooks/queries';
import { useJournalFeed } from '~/hooks/journal-feed';
import { formatDateTime, formatRelative } from '~/lib/format';

import { ManagerStatusBadge } from './managers';

/**
 * 普段の接点。
 *
 * PRD の可観測性は「日報だけ読んで暮らせるが、掘れば生ログまで一本道で降りられる」
 * ことを求めている。だからここは**日報が主役**で、他は「今どうなっているか」を
 * 一目で見るためのものに留める。
 */
export default function Dashboard() {
  const reports = useReports(1);
  const approvals = useApprovals(true);
  const managers = useManagers();
  const schedule = useSchedule();
  // **`useJournalLive()` を直に呼ばない。** SSE は `AuthedShell` が1本だけ張る決まりで、
  // ここが自分で呼ぶとダッシュボードを開いているあいだ2本になる（#27 でそうなっていた。
  // 意図があった形跡はコメントにも履歴にも無く、`shell.tsx` は最初から「ここで1本だけ
  // 張る」と書いてあったので、漏れとして context 越しに寄せた）。**戻さないこと。**
  const live = useJournalFeed();
  // 「今日」はローカル時刻（日報と同じ区切り）。UTC で切ると日報の「今日」とずれる。
  const today = usageDate(new Date());
  const usage = useUsage({ from: today, to: today });

  const latestReport = reports.data?.reports[0];
  const pending = approvals.data?.approvals ?? [];
  const running = (managers.data?.managers ?? []).filter((m) => m.status === 'running');

  return (
    <Page title="ダッシュボード" description="いま何が動いていて、何が人間を待っているか">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="最新の日報"
            subtitle={latestReport === undefined ? undefined : latestReport.date}
            action={
              <Link to="/reports" className="text-xs text-accent hover:underline">
                すべて見る
              </Link>
            }
          />
          {reports.error !== undefined ? (
            <ErrorNote error={reports.error} className="m-4" />
          ) : reports.isLoading ? (
            <Spinner />
          ) : latestReport === undefined ? (
            <Empty>まだ日報がない。締め時刻を待つか、スケジュールから今すぐ回せる。</Empty>
          ) : (
            <div className="max-h-96 overflow-y-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
              {latestReport.body}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              title="承認待ち"
              subtitle="人間が答えるまで、この仕事だけが止まる"
              action={
                pending.length > 0 ? (
                  <Link to="/approvals" className="text-xs text-accent hover:underline">
                    答える
                  </Link>
                ) : undefined
              }
            />
            {approvals.error !== undefined ? (
              <ErrorNote error={approvals.error} className="m-4" />
            ) : pending.length === 0 ? (
              <Empty>なし。</Empty>
            ) : (
              <ul>
                {pending.slice(0, 5).map((approval) => (
                  <li
                    key={approval.id}
                    className="border-b border-border px-4 py-2 last:border-b-0"
                  >
                    <Link to="/approvals" className="block text-sm hover:text-accent">
                      <span className="line-clamp-2">{approval.question}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {formatRelative(approval.createdAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="稼働中のマネージャー"
              action={
                <Link to="/managers" className="text-xs text-accent hover:underline">
                  一覧
                </Link>
              }
            />
            {managers.error !== undefined ? (
              <ErrorNote error={managers.error} className="m-4" />
            ) : running.length === 0 ? (
              <Empty>いま走っているものはない。</Empty>
            ) : (
              <ul>
                {running.slice(0, 5).map((manager) => (
                  <li
                    key={manager.managerId}
                    className="border-b border-border px-4 py-2 last:border-b-0"
                  >
                    <Link
                      to={`/managers/${manager.managerId}`}
                      className="flex items-center gap-2 text-sm hover:text-accent"
                    >
                      <ManagerStatusBadge status={manager.status} />
                      <span className="min-w-0 flex-1 truncate">{manager.request}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="今日の利用"
              subtitle="推定値。請求明細ではない"
              action={
                <Link to="/usage" className="text-xs text-accent hover:underline">
                  詳しく見る
                </Link>
              }
            />
            {usage.error !== undefined ? (
              <ErrorNote error={usage.error} className="m-4" />
            ) : usage.isLoading || usage.data === undefined ? (
              <Spinner />
            ) : usage.data.since === null ? (
              // **`$0.00` と出さない。** まだ台帳に1件も無いのを「使っていない」に見せない。
              <Empty>まだ記録が無い。</Empty>
            ) : usage.data.beforeLedger && usage.data.rows.length === 0 ? (
              // **0 と出さない。** 台帳の始点より前を「使っていない」に見せない。
              <Empty>今日の分はまだ記録が無い（台帳の始点より前）。</Empty>
            ) : (
              <div className="px-4 py-3">
                <p className="text-xl font-semibold">
                  {formatUsd(summarizeUsage(usage.data.rows).total.costUsd)}
                </p>
                {/* 省略・要約しない。数字を出すところには必ず添える。 */}
                <p className="mt-1 text-[11px] text-muted">{usage.data.notice}</p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="次の自動実行" />
            {schedule.data === undefined ? (
              <Empty>—</Empty>
            ) : (
              <ul>
                {schedule.data.entries.map((entry) => (
                  <li
                    key={entry.kind}
                    className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-muted">{entry.description}</span>
                    <Badge tone="accent">{formatRelative(entry.nextAt)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        {/*
          購読は画面ではなく `AuthedShell` が持つので、この画面を開き直しても溜まった
          ものは消えない。だから「この画面を開いてから」とは書けない。
        */}
        <CardHeader
          title="いま届いている出来事"
          subtitle="接続してから流れてきた日誌"
          action={
            <Link to="/journal" className="text-xs text-accent hover:underline">
              日誌を掘る
            </Link>
          }
        />
        {live.recent.length === 0 ? (
          <Empty>まだ何も届いていない。</Empty>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {live.recent.slice(0, 30).map((entry) => (
              <li
                key={entry.id}
                className="flex gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0"
              >
                <span className="shrink-0 font-mono text-[11px] text-muted">
                  {formatDateTime(entry.at)}
                </span>
                <Badge>{entry.type}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {summarizeJournalEntry(entry)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
