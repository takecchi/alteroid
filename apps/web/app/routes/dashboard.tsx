import { isRunningJobStatus, JOB_STATUS_LIKE_VALUES } from '@alteroid/core/job-status-running';
import { formatUsd, summarizeUsage, usageDate } from '@alteroid/core/usage';
import { Link } from 'react-router';

import {
  Markdown,
  Page,
  Badge,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Spinner,
  TruncationNote,
} from '@alteroid/ui';
import {
  summarizeJournalEntry,
  useApprovals,
  useManagers,
  useReports,
  useSchedule,
  useUsage,
  useJournalFeed,
} from '@alteroid/swr';
import { formatDateTime, formatRelative, managersHref, usageHref } from '@alteroid/logic';
import { journalEntryLinks } from '~/lib/journal-links';

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
const APPROVALS_MALFORMED_MESSAGE = '承認待ちを読めていない（応答の形が想定と違う）';
const MANAGER_LIMIT = 5;
const LIVE_LIMIT = 30;

/**
 * 「今日の利用」を引く窓の片側の日数（issue #2268）。
 *
 * **「今日」はデーモンが決める**（`GET /usage` の `today`。台帳の `date` はデーモンの TZ の
 * 暦で切られる）。ブラウザはそれを引く前に知らないので、ブラウザの今日の前後にこの日数だけ
 * 広げた窓で1回引き、応答の `today` の行だけを使う。TZ のオフセットは UTC−12〜UTC+14 で、
 * 同じ瞬間の暦の日は最大2日ずれる——だから2日である（1日では足りない）。
 */
const USAGE_WINDOW_DAYS = 2;

/** `base` の暦（ブラウザの TZ）の日から `days` 日ずらした日を `YYYY-MM-DD` で返す。 */
function shiftedDate(base: Date, days: number): string {
  return usageDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days));
}

/**
 * 「稼働中のマネージャー」カードの「一覧」が飛ぶ先の絞り込み（issue #2090）。
 *
 * カード自身の絞り込み（下の `running` の doc）と**同じ母集合**から作る——
 * `running` を文字列で書き写すと、`isRunningJobStatus` が真にする状態が増えた
 * 日にリンクだけ古びる。`JOB_STATUS_LIKE_VALUES` と `isRunningJobStatus` はどちらも
 * `@alteroid/core/job-status-running`（zod を import しない軽い口）から取るので、
 * ブラウザバンドルへ core 全体が入らない。
 */
const RUNNING_STATUSES = JOB_STATUS_LIKE_VALUES.filter(isRunningJobStatus);

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
  // **「今日」はデーモンの TZ の日**（日報・台帳の区切りと同じ。ブラウザの TZ ではない）。
  // デーモンの今日は応答の `today` が言う。ブラウザの今日の前後 `USAGE_WINDOW_DAYS` 日の窓で
  // 1回だけ引き、応答の `today` の行だけを「今日の利用」にする（issue #2268）。
  const browserNow = new Date();
  const usage = useUsage({
    from: shiftedDate(browserNow, -USAGE_WINDOW_DAYS),
    to: shiftedDate(browserNow, USAGE_WINDOW_DAYS),
  });
  // **`today` が無いとき（読み込み中・`today` を返さない古いデーモン）に、黙ってブラウザの
  // 今日にしない。** 型は `string` だが、古いデーモンの応答には無いので `undefined` を許す。
  const today: string | undefined = usage.data?.today;
  const todayRows = usage.data?.rows.filter((row) => row.date === today) ?? [];
  const todayTurnRows = usage.data?.turnRows.filter((row) => row.date === today) ?? [];

  const latestReport = reports.data?.reports[0];
  // **形の違う応答（`approvals` が配列でない）を `?? []` で0件にしない**（issue #2308。外枠
  // `shell.tsx` の PR #2307 と同じ判断）。デーモンと画面は版がずれうるので、読めていないのに
  // 「なし。」と描くと嘘になる。`null` も読み込み中（`undefined`）とは別で「読めていない」へ倒す。
  const approvalsList = Array.isArray(approvals.data?.approvals)
    ? approvals.data.approvals
    : undefined;
  const approvalsMalformed = approvals.data !== undefined && approvalsList === undefined;
  const pending = approvalsList ?? [];
  // **`m.status === 'running'` を直書きしない。** 将来「実行中」を意味する
  // 新しい値が `jobStatusSchema` に足されても件数から漏らさないための唯一の
  // 判定を `@alteroid/core/job-status-running` から取る（そちらの doc に
  // 経緯——直書きが実際にこの穴を持っていたこと——がある）。
  const running = (managers.data?.managers ?? []).filter((m) => isRunningJobStatus(m.status));

  return (
    <Page title="ダッシュボード" description="いま何が動いていて、何が人間を待っているか">
      {/*
        ⚠️ #295: この grid にも基底の `grid-cols-*` が無い
        （`grid gap-4 lg:grid-cols-3`）。暗黙トラックは auto。

        直接の子は2つある。
        - 1つ目 `<Card className="flex min-w-0 flex-col lg:col-span-2">`
          は自分自身が `min-w-0` を持つ。
        - 2つ目 `<div className="flex flex-col gap-4">`（このすぐ下）は
          緩和クラスを持たない。膨らみを止めているのは孫以下 —
          「稼働中のマネージャー」カードの
          `<span className="min-w-0 flex-1 truncate">` と「次の自動実行」
          カードの同種の span（`truncate` を含む。usage.tsx と同じ理屈。
          そちらの grid の直上コメントを参照）。

        ⚠️ ただし「承認待ち」カード（2つ目の子の1枚目）は形が違う —
        質問文は `<span className="line-clamp-2">` で、`truncate` ではない。
        実測（`tailwindcss@4.3.3` のユーティリティ定義を grep で確認）:
        `line-clamp-2` は `overflow:hidden` / `display:-webkit-box` /
        `-webkit-box-orient:vertical` / `-webkit-line-clamp:2` だけで、
        `truncate` と違って `white-space: nowrap` を含まない。つまり折り
        返す。折り返す要素の min-content 寄与は「いちばん長い、改行できな
        い連続」の幅であって 0 ではない（`question` は自由記述で、URL・
        パス・識別子など空白の無い文字列を含みうる）。**このカードだけは
        「min-w-0 は既に有界なものへの冗長な下限だから無害」という説明が
        同じ形では成り立たない** — もし直接の子へ `min-w-0` を足すと、
        いま確保されている下限が外れ、その連続が途中で切れうる。

        ⚠️ 「切れうる」もここまでの CSS 定義の読みからの推論であって、
        実測ではない。jsdom はレイアウトを持たず、視覚回帰の道具
        （Playwright / Storybook / Chromatic）も無く、Vercel の preview は
        release/prod へ push されるまで出ない。詳細と再オープン条件は
        #295。
      */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex min-w-0 flex-col lg:col-span-2">
          <CardHeader
            title="最新の日報"
            subtitle={latestReport === undefined ? undefined : latestReport.date}
            action={
              <Link to="/reports" className="text-xs text-primary hover:underline">
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
                // **読めていないときは出さない（issue #2138 の2）。** 本文
                // （すぐ下の `approvals.error !== undefined ? …` と同じ判定
                // ではなく `pending.length > 0` だけを見ていたので、取り直しに
                // 失敗して `data` が古いまま残ると「読めていない」（本文）と
                // 「答える（古い件数由来）」（見出し）が同じカードに同時に
                // 出ていた。本文と同じ判定を先頭に足して揃える。
                approvals.error === undefined && !approvalsMalformed && pending.length > 0 ? (
                  <Link to="/approvals" className="text-xs text-primary hover:underline">
                    答える
                  </Link>
                ) : undefined
              }
            />
            {approvals.error !== undefined ? (
              <ErrorNote error={approvals.error} className="m-4" />
            ) : approvalsMalformed ? (
              <ErrorNote error={new Error(APPROVALS_MALFORMED_MESSAGE)} className="m-4" />
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
                      <Link to="/approvals" className="block text-sm hover:text-primary">
                        {/*
                          一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の
                          doc）。`line-clamp-2` の内側へブロック要素を入れると、その
                          畳み方そのものが効かなくなる。
                        */}
                        <span className="line-clamp-2">{approval.question}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
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
                <Link
                  to={managersHref({ status: RUNNING_STATUSES })}
                  className="text-xs text-primary hover:underline"
                >
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
                        className="flex items-center gap-2 text-sm hover:text-primary"
                      >
                        <ManagerStatusBadge status={manager.status} />
                        {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
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
                // **カードの数字（`usage`）と同じ母集合（今日1日）で飛ぶ（issue
                // #2078）。** `today` はこのカードが集計に使っているのと同じ
                // 変数（応答の `today`）——別に作り直すと、カードとリンク先の「今日」が
                // ずれうる。分からないうちは、ブラウザの今日で飛ばずリンクを出さない。
                today === undefined ? undefined : (
                  <Link
                    to={usageHref({ from: today, to: today })}
                    className="text-xs text-primary hover:underline"
                  >
                    詳しく見る
                  </Link>
                )
              }
            />
            {usage.error !== undefined ? (
              <ErrorNote error={usage.error} className="m-4" />
            ) : usage.isLoading || usage.data === undefined ? (
              <Spinner />
            ) : today === undefined ? (
              // **0 や記録なしと出さない。** デーモンが今日を返さないので、どの行が今日かを
              // 決められない（古いデーモン）。ブラウザの今日で代用すると TZ が違えば別の日を
              // 「今日」と言う。
              <Empty>デーモンの今日が分からない（デーモンが古い可能性がある）。</Empty>
            ) : usage.data.since === null ? (
              // **`$0.00` と出さない。** まだ台帳に1件も無いのを「使っていない」に見せない。
              <Empty>まだ記録が無い。</Empty>
            ) : usage.data.beforeLedger && todayRows.length === 0 ? (
              // **0 と出さない。** 台帳の始点より前を「使っていない」に見せない。
              // `beforeLedger` は窓（今日の前後2日）に対する判定で、今日そのものではない——
              // だから「今日が始点より前」とは言い切らず、「かかっている可能性」と言う。
              <Empty>
                今日の分はまだ記録が無い（台帳の始点より前にかかっている可能性がある）。
              </Empty>
            ) : (
              <div className="px-4 py-3">
                <p className="text-xl font-semibold">
                  {formatUsd(summarizeUsage(todayRows, todayTurnRows).total.costUsd)}
                </p>
                {/* 省略・要約しない。数字を出すところには必ず添える。 */}
                <p className="mt-1 text-[11px] text-muted-foreground">{usage.data.notice}</p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="次の自動実行"
              action={
                <Link to="/schedule" className="text-xs text-primary hover:underline">
                  詳しく見る
                </Link>
              }
            />
            {schedule.error !== undefined ? (
              // **エラーを最優先する（issue #2138 の1）。** ここは `data` しか
              // 見ていなかったので、一度取れた後に取り直しが失敗しても
              // （SWR は直前の `data` を残す）古い予定を今の値として出し続けて
              // いた——「承認待ち」カードの本文（`approvals.error !== undefined`
              // を `data` より先に見る）と同じ判断をここでも採る。
              <ErrorNote error={schedule.error} className="m-4" />
            ) : schedule.data === undefined ? (
              // 読み込み中（まだ一度も取れていない）。既存の見た目のまま
              // （「予定が無い」の空表示と紛れるが、数百 ms で `data` か
              // `error` のどちらかへ必ず変わるので専用の見た目は足さない）。
              <Empty>—</Empty>
            ) : (
              <ul>
                {schedule.data.entries.map((entry) => (
                  <li
                    key={entry.kind}
                    className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm last:border-b-0"
                  >
                    <span
                      className="min-w-0 truncate text-muted-foreground"
                      title={entry.description}
                    >
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
            <Link to="/journal" className="text-xs text-primary hover:underline">
              日誌を掘る
            </Link>
          }
        />
        {live.recent.length === 0 ? (
          <Empty>まだ何も届いていない。</Empty>
        ) : (
          <>
            {/*
              **`total` は `live.recent.length` ではなく `live.receivedCount`
              を使う。** 購読側（`use-journal-live.ts`）は `RECENT_LIMIT`
              （200件）で頭打ちにしているので、`recent.length` は届いた総数が
              200 を超えた時点で貼り付いて増えなくなる — それを `total` に
              使うと、200件を超えて届いた分がここの但し書きから静かに消える
              （購読側が落とした事実がここでは数えられなかった、という旧来の
              制約は `receivedCount` を足したことで解消した）。`receivedCount`
              は上限を掛けずに1件ごと積んだ値なので、ここで両方の切り捨て
              （購読側の `RECENT_LIMIT` と、この画面が更に絞る `LIVE_LIMIT`）を
              合わせて「残り何件を出していないか」が言える（`/journal` に
              全部残っている旨は上のリンクが担う）。

              **`?? live.recent.length` は `receivedCount` を持たない呼び手の
              ための後方互換のフォールバックである。** 実装（`useJournalLive`）
              は必ず `receivedCount` を返すので、実際にこの画面が使う値には
              掛からない — 掛かるのはこの型を直に組み立てるテストダブルだけ。
            */}
            <ul className="max-h-72 overflow-y-auto">
              {live.recent.slice(0, LIVE_LIMIT).map((entry) => (
                <li
                  key={entry.id}
                  className="flex gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0"
                >
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatDateTime(entry.at)}
                  </span>
                  <Badge>{entry.type}</Badge>
                  {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {summarizeJournalEntry(entry)}
                  </span>
                  {/*
                    **行が指している実体の詳細へつなぐ（issue #2071）。** `/journal` の
                    開いた行（#2064）と同じ `journalEntryLinks` を使う。この行は開閉
                    しない1行なので、短い名前だけを右端に置き、全文は `title` に入れる。
                  */}
                  {journalEntryLinks(entry).map((link) => (
                    <Link
                      key={link.to}
                      to={link.to}
                      title={link.label}
                      aria-label={link.label}
                      className="shrink-0 text-[11px] text-primary hover:underline"
                    >
                      {link.short} →
                    </Link>
                  ))}
                </li>
              ))}
            </ul>
            <TruncationNote shown={LIVE_LIMIT} total={live.receivedCount ?? live.recent.length} />
          </>
        )}
      </Card>
    </Page>
  );
}
