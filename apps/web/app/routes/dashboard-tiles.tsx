import {
  describeUnreadableUsageRows,
  formatUsd,
  summarizeUsage,
  usageDate,
} from '@alteroid/core/usage';
import { CalendarClock, Coins, Hourglass } from 'lucide-react';
import { Link } from 'react-router';

import {
  Empty,
  ErrorNote,
  HOME_LINK_CLASS,
  HomeTile,
  HomeTileNote,
  Spinner,
  Stat,
} from '@alteroid/ui';
import { useProgress, useSchedule, useUsage } from '@alteroid/swr';
import { formatRelative, usageHref, type Progress } from '@alteroid/logic';

import { UnreadableScheduleNote } from './schedule';
import { UnreadableUsageRowsNote } from './usage';

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

/** 小さなカードの3枚（最新の日報は `dashboard-report.tsx` の全幅の枠）。各ページへの入口で、数字は1〜2個だけ置く。 */
export function HomeTiles() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <ProgressTile />
      <NextRunTile />
      <UsageTile />
    </div>
  );
}

/** 数が欠けうるか（読めなかった行・刈られた行・読めなかった作業）。欠けうるなら下限として言う。 */
function progressPartial(progress: Progress): boolean {
  const { completeness } = progress.backlog;
  // 読めない作業の行（#2345）は古いデーモンだと欄が無い。無いことは 0 件ではないが、言えることが無い。
  const unreadableJobs = (completeness as { unreadableJobs?: number }).unreadableJobs ?? 0;
  return completeness.unreadable !== 0 || completeness.trimmedClosed !== 0 || unreadableJobs !== 0;
}

/** 窓の時間数を、日で割り切れるときは日で言う（168 時間 → 7 日）。 */
function windowText(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24} 日` : `${hours} 時間`;
}

/**
 * 作業の進捗。任せた作業のうち実行中の件数・未了の仕事・窓の中で閉じた件数。**割合は出さない**
 * （分母が無い）。大きな数字が何の件数かは `label` で言い、ほかの2つの件数は `hint` に名前付きで置く。
 *
 * **取り直しの失敗は、古い数を残したまま、その場で言う**（issue #3069）。SWR は再取得が失敗しても
 * 直前の `data` を残して `error` を立てるので、`data` だけ見ると止まった数が今の値に見える。
 * `NextRunTile`（#2138 の1）は失敗を先に見て数を隠すが、こちらは人間の決定で数を隠さない
 * （失敗で画面を奪わない）。数の上に注記を置く。
 */
function ProgressTile() {
  const progress = useProgress();
  const data = progress.data;
  return (
    <HomeTile
      icon={Hourglass}
      title="作業の進捗"
      action={
        <Link to="/progress" className={HOME_LINK_CLASS}>
          詳しく見る
        </Link>
      }
    >
      {progress.error !== undefined && data === undefined ? (
        <ErrorNote error={progress.error} />
      ) : data === undefined ? (
        <Spinner />
      ) : (
        <>
          {progress.error !== undefined && (
            <HomeTileNote tone="warn">
              最新の数を取り直せなかった。下の数は前に読めたときのもの。
            </HomeTileNote>
          )}
          <Stat
            label="実行中の任せた作業"
            value={String(data.inProgress.running)}
            unit="件"
            hint={`未了の仕事 ${data.backlog.total} 件・直近 ${windowText(data.window.hours)}で閉じた仕事 ${data.throughput.commitmentsClosed} 件`}
          />
          {progressPartial(data) ? (
            // 数が下限でしかないときは「無い」と言い切らない（issue #3538）。下限の注記だけにする。
            <HomeTileNote tone="warn">読めなかった行があり、数は下限として読むこと。</HomeTileNote>
          ) : (
            data.inProgress.running === 0 &&
            data.backlog.total === 0 && (
              <HomeTileNote>
                いま動いている作業も未了の仕事も無い。何かを任せると、ここに出る。
              </HomeTileNote>
            )
          )}
        </>
      )}
    </HomeTile>
  );
}

/**
 * 次の自動実行。いちばん近い1件と、残りの件数。
 *
 * **取り直しの失敗は、古い予定を残したまま、その場で言う**（issue #3346。進捗のタイルの #3069 と
 * 同じ形）。SWR は再取得が失敗しても直前の `data` を残して `error` を立てるので、`data` だけ見ると
 * 止まった予定が今の値に見える（issue #2138 の1）。だから注記を置く。`data` が無いときだけエラーにする。
 */
function NextRunTile() {
  const schedule = useSchedule();
  const entries = schedule.data?.entries;
  // 時刻が読めないものは「いちばん近い」の候補にしない。全部読めなければ先頭を使う。
  const next = entries
    ?.filter((entry) => !Number.isNaN(Date.parse(entry.nextAt)))
    .reduce<(typeof entries)[number] | undefined>(
      (best, entry) =>
        best === undefined || Date.parse(entry.nextAt) < Date.parse(best.nextAt) ? entry : best,
      undefined,
    );
  const shown = next ?? entries?.[0];
  return (
    <HomeTile
      icon={CalendarClock}
      title="次の自動実行"
      action={
        <Link to="/schedule" className={HOME_LINK_CLASS}>
          予定へ
        </Link>
      }
    >
      {schedule.error !== undefined && schedule.data === undefined ? (
        <ErrorNote error={schedule.error} />
      ) : schedule.data === undefined ? (
        <Spinner />
      ) : (
        <>
          {schedule.error !== undefined && (
            <HomeTileNote tone="warn">
              最新の予定を取り直せなかった。下の予定は前に読めたときのもの。
            </HomeTileNote>
          )}
          {/* 読めない継続中の依頼を、一覧が空に見えることで隠さない（issue #2343）。 */}
          <UnreadableScheduleNote unreadable={schedule.data.unreadable ?? []} className="mb-2" />
          {shown === undefined ? (
            <p className="text-sm text-muted-foreground">
              {/* 読めない依頼が在るのに「ない」と言い切らない（issue #3538。定期ジョブの画面と同じ言い方）。 */}
              {(schedule.data.unreadable ?? []).length > 0
                ? '読めた範囲では、予定はない。'
                : '予定はない。'}
            </p>
          ) : (
            <Stat
              label={<span title={shown.description}>{shown.description}</span>}
              value={formatRelative(shown.nextAt)}
              hint={
                schedule.data.entries.length > 1
                  ? `ほか ${schedule.data.entries.length - 1} 件`
                  : undefined
              }
              className="[&_p:first-child]:truncate"
            />
          )}
        </>
      )}
    </HomeTile>
  );
}

/**
 * 今日の利用（推定）。`/usage` 画面・CLI と同じ嘘をつかない規約を守る（`apps/cli/src/usage.ts`
 * の docstring と同じ）:
 *
 * - **「今日」はデーモンの TZ の日**（応答の `today`）。ブラウザの今日の前後 `USAGE_WINDOW_DAYS`
 *   日の窓で1回だけ引き、`today` の行だけを使う（issue #2268）。`today` が無いとき（読み込み中・
 *   古いデーモン）に黙ってブラウザの今日にしない
 * - 記録が空（`since` が null）・記録の始点より前は `$0.00` と出さない（使っていない、に見せない）
 * - 金額には必ず但し書き（`notice`）を添える。省略・要約しない
 * - 取り直しの失敗は、古い金額を残したまま、その場で言う（issue #3346。進捗のタイルと同じ形）。
 *   「記録が無い」などの枝も前に読めたときの言い分なので、同じ注記を上に置く
 * - 読めずに集計から外した行が在れば、合計に入っていないと言う（Issue #2427）。窓から今日の行か
 *   日が取れない行だけに絞る
 */
function UsageTile() {
  const browserNow = new Date();
  const usage = useUsage({
    from: shiftedDate(browserNow, -USAGE_WINDOW_DAYS),
    to: shiftedDate(browserNow, USAGE_WINDOW_DAYS),
  });
  // 型は `string` だが、古いデーモンの応答には無いので `undefined` を許す。
  const today: string | undefined = usage.data?.today;
  const todayRows = usage.data?.rows.filter((row) => row.date === today) ?? [];
  const todayTurnRows = usage.data?.turnRows.filter((row) => row.date === today) ?? [];
  // 注記（`UnreadableUsageRowsNote`）に渡すのと同じ集合。外した行が在るなら、記録は在る。
  const unreadableRows = usage.data?.unreadableRows?.filter(
    (row) => row.date === undefined || row.date === today,
  );
  const hasUnreadable = describeUnreadableUsageRows(unreadableRows).length > 0;

  return (
    <HomeTile
      icon={Coins}
      title="今日の利用"
      action={
        // カードの数字と同じ母集合（今日1日）で飛ぶ（issue #2078）。分からないうちは、
        // ブラウザの今日で飛ばずリンクを出さない。
        today === undefined ? undefined : (
          <Link to={usageHref({ from: today, to: today })} className={HOME_LINK_CLASS}>
            詳しく見る
          </Link>
        )
      }
    >
      {usage.error !== undefined && usage.data !== undefined && (
        <HomeTileNote tone="warn">
          最新の利用を取り直せなかった。下は前に読めたときのもの。
        </HomeTileNote>
      )}
      {usage.error !== undefined && usage.data === undefined ? (
        <ErrorNote error={usage.error} />
      ) : usage.data === undefined ? (
        <Spinner />
      ) : today === undefined ? (
        // 0 や記録なしと出さない。デーモンが今日を返さないので、どの行が今日かを決められない。
        <Empty>サーバの今日が分からない（サーバが古い可能性がある）。</Empty>
      ) : usage.data.since === null ? (
        // `$0.00` と出さない。まだ記録が1件も無いのを「使っていない」に見せない。
        <Empty>
          {hasUnreadable
            ? '読めた記録は無い。読めずに外した行がある（下の注記）。'
            : 'まだ記録が無い。作業が動き出すと、使った分がここに記録される。'}
        </Empty>
      ) : usage.data.beforeLedger && todayRows.length === 0 ? (
        // 0 と出さない。`beforeLedger` は窓（今日の前後2日）に対する判定で、今日そのものではない。
        <Empty>
          {hasUnreadable
            ? '今日の分は、読めた記録が無い。読めずに外した行がある（下の注記）。'
            : '今日の分はまだ記録が無い。記録は途中から始まったので、その前の分は残っていない。作業が動けば、この先の分が記録される。'}
        </Empty>
      ) : (
        <>
          <Stat
            label="推定"
            value={formatUsd(summarizeUsage(todayRows, todayTurnRows).total.costUsd)}
          />
          <HomeTileNote>{usage.data.notice}</HomeTileNote>
        </>
      )}
      {usage.data !== undefined && today !== undefined && (
        <UnreadableUsageRowsNote rows={unreadableRows} className="mt-2" />
      )}
    </HomeTile>
  );
}
