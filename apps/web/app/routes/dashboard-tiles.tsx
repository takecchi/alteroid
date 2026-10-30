import { describeUnreadableUsageRows, formatUsd, summarizeUsage } from '@alteroid/core/usage';
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
import { formatRelative, redactBody, usageHref, type Progress } from '@alteroid/logic';

import { StaleNote } from '~/components/stale-note';
import { useMinuteNow } from '~/lib/use-now';
import { shiftedUsageDate } from '~/lib/usage-dates';

import { UnreadableScheduleNote } from './schedule';
import { UnmeteredUsageNote, UnreadableUsageRowsNote } from './usage';

// 窓を2日より狭くしない: TZ のオフセットで同じ瞬間の暦の日が最大2日ずれ、1日では足りないため
const USAGE_WINDOW_DAYS = 2;

const HOME_REFRESH_MS = 30_000;

export function HomeTiles() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <ProgressTile />
      <NextRunTile />
      <UsageTile />
    </div>
  );
}

function progressPartial(progress: Progress): boolean {
  const { completeness } = progress.backlog;
  return completeness.unreadable !== 0 || completeness.unreadableJobs !== 0;
}

function windowText(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24} 日` : `${hours} 時間`;
}

// 割合を出さない: 分母が無いため
// 取り直しの失敗で数を隠さない: 失敗で画面を奪わないため（数の上に注記を置く）
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
          {progress.error !== undefined && <StaleNote what="数" />}
          <Stat
            label="実行中の任せた作業"
            value={String(data.inProgress.running)}
            unit="件"
            hint={`未了の仕事 ${data.backlog.total} 件・直近 ${windowText(data.window.hours)}で閉じた仕事 ${data.throughput.tasksClosed} 件`}
          />
          {progressPartial(data) ? (
            // 「無い」と言い切らない: 数が下限でしかないため
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

function NextRunTile() {
  const schedule = useSchedule();
  const entries = schedule.data?.entries;
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
          {schedule.error !== undefined && <StaleNote what="予定" />}
          <UnreadableScheduleNote unreadable={schedule.data.unreadable ?? []} className="mb-2" />
          {shown === undefined ? (
            <p className="text-sm text-muted-foreground">
              {/* 「ない」と言い切らない: 読めない依頼が在るため */}
              {(schedule.data.unreadable ?? []).length > 0
                ? '読めた範囲では、予定はない。'
                : '予定はない。'}
            </p>
          ) : (
            <Stat
              label={
                <span title={redactBody(shown.description)}>{redactBody(shown.description)}</span>
              }
              value={formatRelative(shown.nextAt)}
              hint={
                schedule.data.entries.length > 1
                  ? `ほか ${schedule.data.entries.length - 1} 件`
                  : undefined
              }
              // 切らずに折り返して全文を読ませる: truncate だと「queu…」のように何の語か読めない
              className="[&_p:first-child]:break-words"
            />
          )}
        </>
      )}
    </HomeTile>
  );
}

// today が無いとき黙ってブラウザの今日にしない: 「今日」はデーモンの TZ の日（応答の today）のため
function UsageTile() {
  const browserNow = new Date(useMinuteNow());
  const from = shiftedUsageDate(browserNow, -USAGE_WINDOW_DAYS);
  const to = shiftedUsageDate(browserNow, USAGE_WINDOW_DAYS);
  const usage = useUsage({ from, to }, { refreshInterval: HOME_REFRESH_MS });
  const serverToday = usage.data?.today;
  // 窓の外なら分からない側へ倒す: 端末の時計がずれると窓が今日を含まず、今日の行を取りに行っていないのに 0 と出てしまうため
  const today =
    serverToday !== undefined && serverToday >= from && serverToday <= to ? serverToday : undefined;
  const todayRows = usage.data?.rows.filter((row) => row.date === today) ?? [];
  const todayTurnRows = usage.data?.turnRows.filter((row) => row.date === today) ?? [];
  const unreadableRows = usage.data?.unreadableRows?.filter(
    (row) => row.date === undefined || row.date === today,
  );
  const hasUnreadable = describeUnreadableUsageRows(unreadableRows).length > 0;
  // 消費を報告しない provider のターンも今日の分に絞って言う（#4800）: 言わないと、それだけの日が「推定 $0.0000」で使っていないように見えるため（/usage と同じ注記）
  const unmeteredRows = usage.data?.unmeteredRows?.filter((row) => row.date === today);

  return (
    <HomeTile
      icon={Coins}
      title="今日の利用"
      action={
        // リンクを出さない: 今日が分からないうちは、ブラウザの今日で飛べないため
        today === undefined ? undefined : (
          <Link to={usageHref({ from: today, to: today })} className={HOME_LINK_CLASS}>
            詳しく見る
          </Link>
        )
      }
    >
      {usage.error !== undefined && usage.data !== undefined && <StaleNote what="利用" />}
      {usage.error !== undefined && usage.data === undefined ? (
        <ErrorNote error={usage.error} />
      ) : usage.data === undefined ? (
        <Spinner />
      ) : today === undefined ? (
        // 0 や記録なしと出さない: デーモンが今日を返さないので、どの行が今日かを決められないため
        <Empty>サーバの今日が分からない（サーバが古い可能性がある）。</Empty>
      ) : usage.data.since === null ? (
        // $0.00 と出さない: まだ記録が1件も無いのを「使っていない」に見せないため
        <Empty>
          {hasUnreadable
            ? '読めた記録は無い。読めずに外した行がある（下の注記）。'
            : 'まだ記録が無い。作業が動き出すと、使った分がここに記録される。'}
        </Empty>
      ) : usage.data.beforeLedger && todayRows.length === 0 ? (
        // 0 と出さない: beforeLedger は窓（今日の前後2日）に対する判定で、今日そのものではないため
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
        <>
          <UnreadableUsageRowsNote rows={unreadableRows} className="mt-2" />
          <UnmeteredUsageNote rows={unmeteredRows} className="mt-2" />
        </>
      )}
    </HomeTile>
  );
}
