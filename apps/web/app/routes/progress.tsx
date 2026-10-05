import { WorkTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import {
  Badge,
  Card,
  CardHeader,
  ChoiceChips,
  KeyValueList,
  Page,
  Spinner,
  Stat,
  type KeyValueItem,
} from '@alteroid/ui';
import { useProgress } from '@alteroid/swr';
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
  const { data, error, isLoading, isValidating, mutate } = useProgress(windowHours);

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
      tabs={<WorkTabs />}
      title="作業の進捗"
      description="たまっている仕事、実行中の依頼、期間内に片付いた数、完了の目安。読み取り専用で、件数と時間だけを並べます"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">集計する期間</span>
        <ChoiceChips
          label="期間の長さ"
          options={WINDOWS.map((hours) => ({ value: String(hours), label: WINDOW_LABEL[hours] }))}
          value={String(windowHours)}
          onChange={(value) => selectWindow(parseWindow(value))}
        />
      </div>

      {error !== undefined && data === undefined ? (
        <Card>
          <LoadError
            what="作業の進捗"
            error={error}
            onRetry={() => mutate()}
            retrying={isValidating}
            className="m-4"
          />
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
        label="開いている Issue / PR"
        value={NONE}
        hint={
          <>まだ記録がありません（0 件という意味ではありません）。{redactBody(github.reason)}</>
        }
      />
    );
  }
  if ((github.state as string) !== 'observed') {
    return (
      <Stat
        label="開いている Issue / PR"
        value={NONE}
        hint={<>この画面が知らない状態です。数は出せません。</>}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        記録された数です（GitHub を直接確かめたものではなく、古さの判定もしていません）。
      </p>
      {github.repos.map((row) => (
        <div key={row.repo} className="flex flex-col gap-2">
          {row.latestOk === null ? (
            <Stat
              label={`${row.repo} の開いている Issue / PR`}
              value={NONE}
              hint={
                github.scan.reachedLimit ? (
                  <>
                    読み取った範囲（新しい順 {count(github.scan.limit)}{' '}
                    件）に成功した記録が無いため、数は分かりません（0 件という意味ではありません）。
                  </>
                ) : (
                  <>成功した記録が無いため、数は分かりません（0 件という意味ではありません）。</>
                )
              }
            />
          ) : (
            <>
              <StatRow>
                <Stat
                  label={`${row.repo} 開いている Issue`}
                  value={count(row.latestOk.openIssues)}
                  unit="件"
                />
                <Stat
                  label={`${row.repo} 開いている PR`}
                  value={count(row.latestOk.openPulls)}
                  unit="件"
                />
              </StatRow>
              <KeyValueList
                items={[
                  {
                    label: '記録した時刻',
                    value: `${atText(row.latestOk.observedAt, observedAt)} / 記録元 ${row.latestOk.observedBy}`,
                  },
                  {
                    label: '数えた範囲',
                    value:
                      row.latestOk.query +
                      (row.latestOk.limit === undefined
                        ? ''
                        : ` / 上限 ${count(row.latestOk.limit)} 件`) +
                      (row.latestOk.truncated ? '（上限に達したため、実際はこれ以上）' : ''),
                  },
                  { label: 'CI', value: ciText(row.latestOk) },
                ]}
                labelWidth="8rem"
              />
            </>
          )}
          {row.latestFailed !== null && (
            <p className="text-xs text-warn">
              取得に失敗した回: {atText(row.latestFailed.observedAt, observedAt)} / 記録元{' '}
              {row.latestFailed.observedBy} — {redactBody(row.latestFailed.reason)}
            </p>
          )}
        </div>
      ))}
      {github.scan.reachedLimit && (
        <p className="text-xs text-warn">
          読み取った記録が上限（新しい順 {count(github.scan.limit)}{' '}
          件）に達しました。古い記録にしかないリポジトリは載っていません。載っているリポジトリでも、
          成功か失敗の記録が読み取りの範囲から外れて欠けていることがあります。
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
      label: '誰からの依頼か',
      value: `人間 ${count(byOrigin.human)} / マネージャー ${count(byOrigin.manager)} / 外部 ${count(byOrigin.external)} / 自分で始めた ${count(byOrigin.self)}`,
    },
    {
      label: 'いちばん古いもの',
      value:
        age.oldestAt === null
          ? `${NONE}（未完了の仕事が無いため）`
          : atText(age.oldestAt, observedAt),
    },
    {
      label: '経過時間の中央値',
      value:
        age.medianHours === null ? `${NONE}（未完了の仕事が無いため）` : hoursText(age.medianHours),
    },
    {
      label: '経過時間の内訳',
      value: `1時間未満 ${count(age.buckets.under1h)} / 24時間未満 ${count(age.buckets.under24h)} / 7日未満 ${count(age.buckets.under7d)} / 7日以上 ${count(age.buckets.over7d)}`,
    },
    {
      label: '進み具合',
      value: `未着手 ${count(byState.untouched)} / 返答済み（まだ閉じていない） ${count(byState.responded)} / マネージャーに任せた ${count(byState.delegated)}（他の項目と重なることがあります） / 人間からの依頼ではない ${count(byState.notApplicable)}`,
    },
  ];

  return (
    <Card>
      <CardHeader title="未完了の仕事" subtitle="引き受けた仕事のうち、まだ終わっていないもの" />
      <Section>
        <StatRow>
          <Stat label="未完了" value={count(backlog.total)} unit="件" />
        </StatRow>
        <KeyValueList items={items} labelWidth="8rem" />
        {partial && (
          <p className="text-xs text-warn">
            数が実際より少ない可能性があります（読み取れなかった記録{' '}
            {count(completeness.unreadable)} 件 / 古くて整理された完了済みの記録{' '}
            {count(completeness.trimmedClosed)}{' '}
            件）。上の数は「少なくともこれだけ」と読んでください。
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
      label: '最後の報告（いちばん古い）',
      value:
        lastReport.oldestAt === null
          ? `${NONE}（報告のある依頼が無い）`
          : atText(lastReport.oldestAt, observedAt),
    },
    {
      label: '最後の報告（いちばん新しい）',
      value:
        lastReport.newestAt === null
          ? `${NONE}（報告のある依頼が無い）`
          : atText(lastReport.newestAt, observedAt),
    },
    { label: 'まだ報告が無い依頼', value: `${count(lastReport.withoutReport)} 件` },
  ];
  return (
    <Card>
      <CardHeader title="実行中の依頼" subtitle="マネージャーに任せた仕事のうち、動いているもの" />
      <Section>
        <StatRow>
          <Stat label="実行中" value={count(inProgress.running)} unit="件" />
          <Stat label="返答待ち" value={count(inProgress.awaitingHuman)} unit="件" />
          <Stat label="連絡が取れない" value={count(inProgress.lost)} unit="件" />
        </StatRow>
        <KeyValueList items={items} labelWidth="8rem" />
        {unreadableJobs !== 0 && (
          <p className="text-xs text-warn">
            読み取れなかった依頼の記録が {count(unreadableJobs)}{' '}
            件あります。上の数は読み取れた分だけで、
            実際はこれ以上です（記録が壊れているだけで、依頼が無いわけではありません）。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          「実行中」は動かし始めたという意味で、進んでいるとは限りません。最後の報告が古い依頼は、
          マネージャーの一覧で確かめてください。
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
        title="完了の速度"
        subtitle={`直近 ${count(window.hours)} 時間（${formatDateTime(window.from)} 〜 ${formatDateTime(window.to)}）`}
      />
      <Section>
        <StatRow>
          <Stat label="引き受けた" value={count(throughput.commitmentsOpened)} unit="件" />
          <Stat label="完了にした" value={count(throughput.commitmentsClosed)} unit="件" />
          <Stat
            label="終わった依頼"
            value={count(throughput.delegationsEnded.count)}
            unit="件"
            hint="最後に更新された時刻からの概算です（終わった正確な時刻は記録されていません）"
          />
        </StatRow>
      </Section>
    </Card>
  );
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  closed_too_few: '期間内に完了した仕事が少なすぎて、計算できません。完了が増えると出ます',
  ledger_younger_than_window:
    '記録の始まりが選んだ期間より新しいため、計算できません。記録が期間ぶんたまるまで待つか、短い期間に切り替えてください',
  history_incomplete:
    '古い完了済みの記録が整理されていて、期間内の完了を数え落としている可能性があるため、計算できません。短い期間に切り替えてみてください',
};

function reasonText(reason: string): string {
  return Object.hasOwn(UNAVAILABLE_REASONS, reason)
    ? (UNAVAILABLE_REASONS[reason] ?? reason)
    : '目安を出せない理由が、この画面では分かりません。画面かデーモンを更新してください';
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
      <CardHeader
        title="見込み"
        subtitle="未完了の仕事がなくなるまでの目安です。約束ではありません"
      />
      <Section>
        <ForecastBody forecast={forecast} />
        {/* 版のずれで basis が欠けても落ちない。 */}
        {(forecast.basis as ProgressForecastBasis | undefined) !== undefined && (
          <BasisList
            basis={forecast.basis}
            {...(forecast.state === 'estimated' ? { notice: forecast.notice } : {})}
          />
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
          <p className="text-xs text-muted-foreground">
            目安です。期間内に新しく引き受けた分は計算に入れていません（上の件数は並べて示しているだけです）。
          </p>
        </>
      );
    case 'not_converging':
      return (
        <>
          <Badge tone="warn">収束していない</Badge>
          <Stat
            label="あと"
            value={NONE}
            hint={`期間内に引き受けた件数（${count(forecast.basis.openedInWindow)} 件）が完了にした件数（${count(forecast.basis.closedInWindow)} 件）以上なので、時間は出せません`}
          />
        </>
      );
    case 'unavailable':
      return (
        <>
          <Badge tone="neutral">見込みを出せない</Badge>
          <Stat label="あと" value={NONE} hint={`${reasonText(forecast.reason)}。`} />
        </>
      );
    default: {
      // 型は網羅済み。ここに来るのは、デーモンが先に新しい状態を返したとき。
      const unknown: never = forecast;
      void unknown;
      return (
        <>
          <Badge tone="neutral">不明な状態</Badge>
          <Stat label="あと" value={NONE} hint="この画面が知らない状態です。時間は出せません" />
        </>
      );
    }
  }
}

function BasisList({ basis, notice }: { basis: ProgressForecastBasis; notice?: string }) {
  const items: KeyValueItem[] = [
    { label: '未完了', value: `${count(basis.open)} 件` },
    { label: '期間内に完了にした', value: `${count(basis.closedInWindow)} 件` },
    { label: '期間内に引き受けた', value: `${count(basis.openedInWindow)} 件` },
    { label: '期間の長さ', value: `${count(basis.windowHours)} 時間` },
  ];
  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-xs text-muted-foreground">計算の元になった数</p>
      <KeyValueList items={items} labelWidth="8rem" />
      {basis.unreadable !== 0 && (
        <p className="mt-2 text-xs text-warn">
          読み取れなかった記録が {count(basis.unreadable)}{' '}
          件あるため、未完了の数は実際より少ない可能性があります。
        </p>
      )}
      {/* 計算式は開発者向けなので、折りたたみの先に置く。 */}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">計算の詳細（開発者向け）</summary>
        <code className="mt-1 block font-mono break-words">{basis.method}</code>
        {notice !== undefined && <p className="mt-1 break-words">{notice}</p>}
      </details>
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
