import { formatUsd, summarizeUsage, usageDate } from '@alteroid/core/usage';
import { Link } from 'react-router';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import {
  Badge,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Spinner,
  TruncationNote,
} from '~/components/ui';
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
// **表示の正本は `reports.tsx` の側に置く。** 日報の面が2つ（ここと `/reports`）
// あるので、判定と文言を書き写すと片方だけが古びる（本文がエラー文のまま出る側が
// 静かに残る）。
import { isUnavailable, UnavailableNote } from './reports';

/**
 * 概要カードに出す件数。**切ること自体は要件である**（ここは一目で見る場所で、
 * 全件はそれぞれの一覧が持つ）。要件でないのは**切ったことが消えること**なので、
 * 定数は `TruncationNote` と必ず対で使う。数字を直接 `slice` に書かないのは、
 * 但し書き側と食い違った瞬間に嘘の件数が出るためである。
 */
const APPROVAL_LIMIT = 5;
const MANAGER_LIMIT = 5;
const LIVE_LIMIT = 30;

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
        <Card className="flex min-w-0 flex-col lg:col-span-2">
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
            /*
              **固定の上限（`max-h-96`）で切らない。** この Card は `lg:col-span-2` で、隣の列
              （Card 4枚の縦積み）のほうが背が高い。grid の stretch で**枠だけ**が下まで伸び、
              中身は上端から 24rem で終わるので、下に死んだ余白が残る（人間の言葉で
              「スクロールエリアが上らへんで終わっている」）。だから上限ではなく
              「24rem を初期値にして、余っている高さのぶんだけ伸びる」で渡す。
              枠と中身の下端が揃い、日報が長ければその中でスクロールする。

              **`flex-1` に置き換えないこと。** `flex-basis: 0%` は親の高さが未確定なとき
              `content` に解決される（CSS Flexbox の規定）ので、日報の全文が grid の行の
              高さになり、こんどは隣の列の下に同じ余白ができる。`h-96` は絶対長なので
              そうならない。狭い画面（1列）では伸びる先が無いので、これまでどおり 24rem。
            */
            <div className="h-96 min-h-0 min-w-0 grow overflow-y-auto px-4 py-3">
              {/*
                **印の付いた行を日報として描かない**（`reports.tsx` の
                `isUnavailable` / `UnavailableNote` の doc が経緯）。ここは人間が
                最初に開く面なので、エラー文が「最新の日報」として出ると、
                塞いだ穴のうち人間に見える側だけがそのまま残る。
              */}
              {isUnavailable(latestReport) ? (
                <UnavailableNote reason={latestReport.unavailable} />
              ) : (
                <Markdown>{latestReport.body}</Markdown>
              )}
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
              <>
                <ul>
                  {pending.slice(0, APPROVAL_LIMIT).map((approval) => (
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
                <TruncationNote shown={APPROVAL_LIMIT} total={pending.length} />
              </>
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
              <>
                <ul>
                  {running.slice(0, MANAGER_LIMIT).map((manager) => (
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
                <TruncationNote shown={MANAGER_LIMIT} total={running.length} />
              </>
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
            <CardHeader
              title="次の自動実行"
              action={
                <Link to="/schedule" className="text-xs text-accent hover:underline">
                  詳しく見る
                </Link>
              }
            />
            {schedule.data === undefined ? (
              <Empty>—</Empty>
            ) : (
              <ul>
                {schedule.data.entries.map((entry) => (
                  <li
                    key={entry.kind}
                    className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-muted" title={entry.description}>
                      {entry.description}
                    </span>
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
          <>
            {/*
              ここで言えるのは「届いた分のうち何件を出していないか」までである。
              購読側（`use-journal-live.ts` の `RECENT_LIMIT`）はさらに古い分を
              落としているので、**この但し書きは「流れた全部」の残数ではない。**
              そちらまで数えるには購読側が落とした事実を返す必要があり、ここでは
              数えられない（`/journal` に全部残っている旨は上のリンクが担う）。
            */}
            <ul className="max-h-72 overflow-y-auto">
              {live.recent.slice(0, LIVE_LIMIT).map((entry) => (
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
            <TruncationNote shown={LIVE_LIMIT} total={live.recent.length} />
          </>
        )}
      </Card>
    </Page>
  );
}
