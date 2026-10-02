import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import {
  Badge,
  Card,
  CardHeader,
  ChoiceChips,
  ErrorNote,
  KeyValueList,
  Page,
  Spinner,
  Stat,
  type KeyValueItem,
} from '@alteroid/ui';
import { ApiError, useProgress } from '@alteroid/swr';
import { formatDateTime, formatRelative, redactBody } from '@alteroid/logic';
import type { Progress, ProgressForecast, ProgressForecastBasis } from '@alteroid/logic';

/**
 * `/progress` — 作業の進捗（積み上がり・実施中・片付いた速度・見込み）を読む
 * （Issue #2241 の 4。画面の設計は同 Issue の最後のコメント）。
 *
 * 経路は `GET /progress` の1本だけ。**読んで並べるだけで、数え直さない・作らない。**
 * CLI（`alteroid progress`）とクローンの道具（`progress_read`）が同じ集計を見る。
 *
 * ## 割合（%）を1つも出さない
 *
 * 台帳には締切も総量も無く、分母（「全部」）が定まらない。だから `Meter` / `StackedBar` /
 * shadcn の `Progress`（どれも割合か、分母を前提にした帯）は使わず、件数と時間だけを
 * `Stat` / `KeyValueList` で並べる。**取れない値（`null`）は `—` と理由で出し、0 とは書かない。**
 *
 * ## 版のずれ
 *
 * Web とデーモンは別々にデプロイされるので、デーモンが知らない `forecast.state` /
 * `reason` を返す時間が在る。型は網羅してあるが、実行時の倒れ先の文言も持つ。
 */

const NONE = '—';

/** 窓の選択肢（時間）。24時間 / 7日 / 30日。 */
const WINDOWS = [24, 168, 720] as const;
type WindowHours = (typeof WINDOWS)[number];
/** デーモンの既定（`GET /progress` の `windowHours` の既定）と揃える。 */
const DEFAULT_WINDOW: WindowHours = 168;
const WINDOW_PARAM = 'windowHours';
const WINDOW_LABEL: Record<WindowHours, string> = { 24: '24時間', 168: '7日', 720: '30日' };

/** URL の `?windowHours=` を窓へ。知らない値・欠けは既定へ倒す（URL は人間が書き換えうる）。 */
function parseWindow(raw: string | null): WindowHours {
  const found = WINDOWS.find((hours) => String(hours) === raw);
  return found ?? DEFAULT_WINDOW;
}

export default function ProgressPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawWindow = searchParams.get(WINDOW_PARAM);
  const windowHours = useMemo(() => parseWindow(rawWindow), [rawWindow]);
  const { data, error, isLoading } = useProgress(windowHours);

  function selectWindow(next: WindowHours) {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set(WINDOW_PARAM, String(next));
        return params;
      },
      { replace: true },
    );
  }

  return (
    <Page
      title="作業の進捗"
      description="積み上がっている仕事・実施中の委譲・窓の中で片付いた速度・見込み。読み取り専用。割合（分母が定まらない）は出さず、件数と時間だけを並べる"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">速度と見込みを数える窓</span>
        <ChoiceChips
          label="窓の長さ"
          options={WINDOWS.map((hours) => ({ value: String(hours), label: WINDOW_LABEL[hours] }))}
          value={String(windowHours)}
          onChange={(value) => selectWindow(parseWindow(value))}
        />
      </div>

      {error !== undefined && data === undefined ? (
        <Card>
          <ProgressErrorNote error={error} />
        </Card>
      ) : data === undefined ? (
        <Card>
          <div className="flex justify-center p-6" aria-busy={isLoading}>
            <Spinner />
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <BacklogCard progress={data} />
          <InProgressCard progress={data} />
          <ThroughputCard progress={data} />
          <ForecastCard progress={data} />
        </div>
      )}
    </Page>
  );
}

/** 404 は「この口を持たない古いデーモン」専用の文言にする（`appraisal-stats.tsx` と同じ判断）。 */
function ProgressErrorNote({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="px-4 py-3 text-sm text-destructive">
        この版のデーモンにはこの口（GET /progress）が無い。デーモンを更新してください。
        進む仕事が0件だった、という意味ではない。
      </div>
    );
  }
  return <ErrorNote error={error} className="m-4" />;
}

/** 件数。`null` になりうる量にはこれを使わない（0 と区別できなくなる）。 */
function count(value: number): string {
  return String(value);
}

function hoursText(value: number | null): string {
  if (value === null) return NONE;
  return `${String(Math.round(value * 10) / 10)} 時間`;
}

/** 時刻と、観測時刻から見た経過。`null` は `—`。 */
function atText(iso: string | null, observedAt: string): string {
  if (iso === null) return NONE;
  return `${formatDateTime(iso)}（${formatRelative(iso, new Date(observedAt).getTime())}）`;
}

function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 px-4 py-4">{children}</div>;
}

function StatRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{children}</div>;
}

/**
 * open の Issue / PR。**デーモンは GitHub を見に行かず、観測した側が記録した数を返すだけ**
 * （Issue #2245）。だから「誰の観測か」「いつか」「母集合の切り方」を必ず並べ、古さは判定しない。
 * 取れなかった回は数を作らず `—` と理由を出し、0 とは書かない。
 */
function GithubBlock({ github, observedAt }: { github: Progress['github']; observedAt: string }) {
  if (github.state === 'not_observed') {
    return (
      <Stat
        label="open の Issue / PR"
        value={NONE}
        hint={<>観測していない（0 件ではない）。{redactBody(github.reason)}</>}
      />
    );
  }
  if ((github.state as string) !== 'observed') {
    return (
      <Stat
        label="open の Issue / PR"
        value={NONE}
        hint={<>この版の画面は知らない状態（{String(github.state)}）。数は出さない。</>}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        観測した側の申告（デーモンは GitHub を見に行かず、値を確かめていない）。古さは判定しない。
      </p>
      {github.repos.map((row) => (
        <div key={row.repo} className="flex flex-col gap-2">
          {row.latestOk === null ? (
            <Stat
              label={`${row.repo} の open の Issue / PR`}
              value={NONE}
              hint={
                github.scan.reachedLimit ? (
                  <>
                    読んだ範囲（新しい順 {count(github.scan.limit)}{' '}
                    件）には成功した観測の記録が無い（0 件ではない）。
                  </>
                ) : (
                  <>成功した観測の記録が無い（0 件ではない）。</>
                )
              }
            />
          ) : (
            <>
              <StatRow>
                <Stat
                  label={`${row.repo} open Issue`}
                  value={count(row.latestOk.openIssues)}
                  unit="件"
                />
                <Stat
                  label={`${row.repo} open PR`}
                  value={count(row.latestOk.openPulls)}
                  unit="件"
                />
              </StatRow>
              <KeyValueList
                items={[
                  {
                    label: '観測',
                    value: `${atText(row.latestOk.observedAt, observedAt)} / 観測者 ${row.latestOk.observedBy}`,
                  },
                  {
                    label: '母集合',
                    value:
                      row.latestOk.query +
                      (row.latestOk.limit === undefined
                        ? ''
                        : ` / limit ${count(row.latestOk.limit)}`) +
                      (row.latestOk.truncated ? '（limit に達した。数は下限）' : ''),
                  },
                  { label: 'CI', value: ciText(row.latestOk) },
                ]}
                labelWidth="8rem"
              />
            </>
          )}
          {row.latestFailed !== null && (
            <p className="text-xs text-warn">
              取れなかった回: {atText(row.latestFailed.observedAt, observedAt)} / 観測者{' '}
              {row.latestFailed.observedBy} — {redactBody(row.latestFailed.reason)}
            </p>
          )}
        </div>
      ))}
      {github.scan.reachedLimit && (
        <p className="text-xs text-warn">
          ⚠ 記録の読みが上限（新しい順 {count(github.scan.limit)}{' '}
          件）に当たった。古い記録にしか現れない repo は載っていない。載っている repo
          でも、成功・失敗の片方が読んだ範囲の外に押し出されて欠けていることがある。
        </p>
      )}
    </div>
  );
}

function BacklogCard({ progress }: { progress: Progress }) {
  const { backlog, github, observedAt } = progress;
  const { byOrigin, age, byState, completeness } = backlog;
  const partial = completeness.unreadable !== 0 || completeness.trimmedClosed !== 0;

  const items: KeyValueItem[] = [
    {
      label: '起点別',
      value: `人間 ${count(byOrigin.human)} / マネージャー ${count(byOrigin.manager)} / 外部 ${count(byOrigin.external)} / 自発 ${count(byOrigin.self)}`,
    },
    {
      label: '最古',
      value:
        age.oldestAt === null
          ? `${NONE}（未了が無いので出せない）`
          : atText(age.oldestAt, observedAt),
    },
    {
      label: '齢の中央値',
      value:
        age.medianHours === null ? `${NONE}（未了が無いので出せない）` : hoursText(age.medianHours),
    },
    {
      label: '齢の帯',
      value: `1時間未満 ${count(age.buckets.under1h)} / 24時間未満 ${count(age.buckets.under24h)} / 7日未満 ${count(age.buckets.under7d)} / 7日以上 ${count(age.buckets.over7d)}`,
    },
    {
      label: '状態別',
      value: `未着手 ${count(byState.untouched)} / 返答済み・未クローズ ${count(byState.responded)} / 委譲あり ${count(byState.delegated)}（他と重なりうる） / 人間起点でない ${count(byState.notApplicable)}`,
    },
  ];

  return (
    <Card>
      <CardHeader title="積み上がり" subtitle="台帳（引き受けた仕事）の未了" />
      <Section>
        <StatRow>
          <Stat label="未了" value={count(backlog.total)} unit="件" />
        </StatRow>
        <KeyValueList items={items} labelWidth="8rem" />
        {partial && (
          <p className="text-xs text-warn">
            ⚠ 数が欠けうる（読めなかった行 {count(completeness.unreadable)} 件 /
            刈り取られた片付き行 {count(completeness.trimmedClosed)}{' '}
            件）。上の数は下限として読むこと。
          </p>
        )}
        <div className="border-t border-border pt-3">
          <GithubBlock github={github} observedAt={observedAt} />
        </div>
      </Section>
    </Card>
  );
}

function InProgressCard({ progress }: { progress: Progress }) {
  const { inProgress, observedAt } = progress;
  const { lastReport } = inProgress;
  // **読めない委譲の行（issue #2345）。** デーモンが古いと欄が無いので、型は number でも
  // 無いことを許す（無いときは「0 件」ではなく、何も言わない）。
  const unreadableJobs =
    (progress.backlog.completeness as { unreadableJobs?: number }).unreadableJobs ?? 0;
  const items: KeyValueItem[] = [
    {
      label: '最終報告（最古）',
      value:
        lastReport.oldestAt === null
          ? `${NONE}（報告のある走行が無い）`
          : atText(lastReport.oldestAt, observedAt),
    },
    {
      label: '最終報告（最新）',
      value:
        lastReport.newestAt === null
          ? `${NONE}（報告のある走行が無い）`
          : atText(lastReport.newestAt, observedAt),
    },
    { label: '報告の無い走行', value: `${count(lastReport.withoutReport)} 件` },
  ];
  return (
    <Card>
      <CardHeader title="実施中" subtitle="委譲（マネージャー）の走行" />
      <Section>
        <StatRow>
          <Stat label="実行中" value={count(inProgress.running)} unit="件" />
          <Stat label="人間待ち" value={count(inProgress.awaitingHuman)} unit="件" />
          <Stat label="行方不明" value={count(inProgress.lost)} unit="件" />
        </StatRow>
        <KeyValueList items={items} labelWidth="8rem" />
        {unreadableJobs !== 0 && (
          <p className="text-xs text-warn">
            ⚠ 読めない委譲の行が {count(unreadableJobs)} 件ある。上の数は読めた委譲の分だけで、
            下限として読むこと（壊れた行であって、居ないのではない）。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          「実行中」は走らせたという意味で、進んでいるとは限らない。最終報告が古い走行を見るなら
          マネージャーの一覧へ。
        </p>
      </Section>
    </Card>
  );
}

function ThroughputCard({ progress }: { progress: Progress }) {
  const { throughput, window } = progress;
  return (
    <Card>
      <CardHeader
        title="片付いた速度"
        subtitle={`直近 ${count(window.hours)} 時間（${formatDateTime(window.from)} 〜 ${formatDateTime(window.to)}）`}
      />
      <Section>
        <StatRow>
          <Stat label="受けた" value={count(throughput.commitmentsOpened)} unit="件" />
          <Stat label="閉じた" value={count(throughput.commitmentsClosed)} unit="件" />
          <Stat
            label="委譲の終了"
            value={count(throughput.delegationsEnded.count)}
            unit="件"
            hint="更新時刻（updatedAt）による近似。終端時刻の欄が無い"
          />
        </StatRow>
      </Section>
    </Card>
  );
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  closed_too_few: '窓の中で閉じた件数が少なすぎる',
  ledger_younger_than_window: '台帳の最古の行が窓より新しい',
  history_incomplete: '古い片付き行が刈り取られていて、窓の中の消化を数え落としうる',
};

function reasonText(reason: string): string {
  return Object.hasOwn(UNAVAILABLE_REASONS, reason)
    ? (UNAVAILABLE_REASONS[reason] ?? reason)
    : `この版の画面は知らない理由（${reason}）`;
}

/** 日にちを添えるのは長いときだけ（48時間以上）。 */
function drainText(hours: number): string {
  const base = hoursText(hours);
  return hours >= 48 ? `${base}（約 ${String(Math.round((hours / 24) * 10) / 10)} 日）` : base;
}

function ForecastCard({ progress }: { progress: Progress }) {
  const forecast = progress.forecast;
  return (
    <Card>
      <CardHeader title="見込み" subtitle="未了が空になるまで。推定であり約束ではない" />
      <Section>
        <ForecastBody forecast={forecast} />
        {/* 版のずれで basis が欠けても落ちない。 */}
        {(forecast.basis as ProgressForecastBasis | undefined) !== undefined && (
          <BasisList basis={forecast.basis} />
        )}
      </Section>
    </Card>
  );
}

function ForecastBody({ forecast }: { forecast: ProgressForecast }) {
  switch (forecast.state) {
    case 'estimated':
      return (
        <>
          <div className="flex items-center gap-2">
            <Badge tone="ok">推定</Badge>
          </div>
          <Stat label="あと約" value={drainText(forecast.hoursToDrain)} />
          <p className="text-xs text-muted-foreground">{forecast.notice}</p>
        </>
      );
    case 'not_converging':
      return (
        <>
          <Badge tone="warn">収束していない</Badge>
          <Stat
            label="あと"
            value={NONE}
            hint={`窓の中で受けた件数（${count(forecast.basis.openedInWindow)} 件）が閉じた件数（${count(forecast.basis.closedInWindow)} 件）以上なので、時間は出さない`}
          />
        </>
      );
    case 'unavailable':
      return (
        <>
          <Badge tone="neutral">見込みを出せない</Badge>
          <Stat
            label="あと"
            value={NONE}
            hint={`理由: ${reasonText(forecast.reason)}。時間は出さない`}
          />
        </>
      );
    default: {
      // 型は網羅済み。ここに来るのは、デーモンが先に新しい状態を返したとき。
      const unknown: never = forecast;
      const state = String((unknown as { state?: unknown }).state);
      return (
        <>
          <Badge tone="neutral">知らない状態</Badge>
          <Stat
            label="あと"
            value={NONE}
            hint={`この版の画面は知らない状態（${state}）。時間は出さない`}
          />
        </>
      );
    }
  }
}

function BasisList({ basis }: { basis: ProgressForecastBasis }) {
  const items: KeyValueItem[] = [
    { label: '未了', value: `${count(basis.open)} 件` },
    { label: '窓で閉じた', value: `${count(basis.closedInWindow)} 件` },
    { label: '窓で受けた', value: `${count(basis.openedInWindow)} 件` },
    { label: '窓の長さ', value: `${count(basis.windowHours)} 時間` },
    { label: '式', value: basis.method, mono: true },
  ];
  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-xs text-muted-foreground">根拠</p>
      <KeyValueList items={items} labelWidth="8rem" />
      {basis.unreadable !== 0 && (
        <p className="mt-2 text-xs text-warn">
          ⚠ 読めなかった台帳の行が {count(basis.unreadable)} 件ある。未了の数は欠けうる。
        </p>
      )}
    </div>
  );
}

/**
 * 成功した観測の CI の軸（#2549）。**`ci` が無いことは「観測していない」と出す**——`success 0` とは書かない。
 * `describeGithubCi`（core）と同じ文言。
 */
function ciText(ok: {
  ci?: {
    pulls: number;
    success: number;
    failure: number;
    pending: number;
    checks: string;
    truncated?: boolean;
  };
  ciUnavailable?: string;
}): string {
  if (ok.ci !== undefined) {
    const ci = ok.ci;
    const counted = ci.success + ci.failure + ci.pending;
    return (
      `${count(ci.pulls)} 件の PR を確認 — success ${count(ci.success)} / failure ${count(ci.failure)} / pending ${count(ci.pending)}` +
      (counted < ci.pulls ? `（チェックが無い等で未集計 ${count(ci.pulls - counted)} 件）` : '') +
      `（数えたもの: ${ci.checks}）` +
      (ci.truncated === true ? '（打ち切り。数は下限）' : '')
    );
  }
  if (ok.ciUnavailable !== undefined) return `取れなかった — ${ok.ciUnavailable}（0 件ではない）`;
  return '観測していない（0 件ではない）';
}
