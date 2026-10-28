/**
 * 率（%）は作らない: 台帳に総量が無く分母が定まらないから。取れないものは 0 と書かない。
 * Node 専用のものは持ち込まない: web 向けバンドルに載りうるから。
 */
import { formatElapsedAgo } from './format-elapsed.js';
import { describeGithubCi } from './progress-github.js';
import type { ProgressView } from './progress-read.js';

const NONE = '—';

const UNAVAILABLE_REASONS: Record<string, string> = {
  closed_too_few: '窓の中で閉じた件数が少なすぎる',
  ledger_younger_than_window: '台帳の最古の行が窓より新しい',
  history_incomplete: '古い片付き行が刈り取られていて、窓の中の消化を数え落としうる',
};

function hours(value: number | null): string {
  if (value === null) return NONE;
  return `${String(Math.round(value * 10) / 10)}時間`;
}

function at(iso: string | null, now: number): string {
  if (iso === null) return NONE;
  return `${iso}（${formatElapsedAgo(iso, now)}）`;
}

/** `completeness.unreadableJobs` を任意にする: 古いデーモンの応答には無く、CLI は応答を型で検査せず渡すから。 */
export type ProgressViewInput = Omit<ProgressView, 'backlog'> & {
  backlog: Omit<ProgressView['backlog'], 'completeness' | 'byState'> & {
    /** `unjudgeable` も任意: 古いデーモンの応答には無く、無いものは 0 と書かず出さない。 */
    byState: Omit<ProgressView['backlog']['byState'], 'unjudgeable'> & { unjudgeable?: number };
    completeness: Omit<ProgressView['backlog']['completeness'], 'unreadableJobs'> & {
      unreadableJobs?: number;
    };
  };
};

/**
 * 固定の文言を参照にする口（`ToolContext.foldFixed` と同じ型）。数・時刻・id・理由は畳まない。
 * 既定は全文を返す口: CLI・HTTP・web は同じ関数を使い、参照が指す先（会話の上の全文）を持たないため。
 */
export type ProgressFold = (id: string, full: string, ref: string) => string;
const FULL: ProgressFold = (_id, full) => full;

export function describeProgress(view: ProgressViewInput, fold: ProgressFold = FULL): string {
  const { window, backlog, inProgress, throughput, forecast, github, observedAt } = view;
  const now = new Date(observedAt).getTime();
  const lines: string[] = [];

  lines.push(`観測時刻: ${observedAt}`);
  // 見出しを縮めた回にだけ、全文の在りかを1行で指す（全文の回は空）
  const legend = fold('progress:legend', '', '（見出しは短縮。全文は最初の progress_read）');
  if (legend !== '') lines.push(legend);

  lines.push(
    '',
    `${fold('progress:head-backlog', '積み上がり（台帳の未了）', '未了')}: ${String(backlog.total)} 件`,
  );
  const origin = backlog.byOrigin;
  lines.push(
    `  起点別: 人間 ${String(origin.human)} / マネージャー ${String(origin.manager)} / ` +
      `外部 ${String(origin.external)} / 自発 ${String(origin.self)}`,
  );
  lines.push(
    `  齢: 最古 ${at(backlog.age.oldestAt, now)} / 中央値 ${hours(backlog.age.medianHours)}`,
  );
  const buckets = backlog.age.buckets;
  lines.push(
    fold(
      'progress:age-buckets',
      `    1時間未満 ${String(buckets.under1h)} / 24時間未満 ${String(buckets.under24h)} / ` +
        `7日未満 ${String(buckets.under7d)} / 7日以上 ${String(buckets.over7d)}`,
      `    <1h ${String(buckets.under1h)} / <24h ${String(buckets.under24h)} / ` +
        `<7d ${String(buckets.under7d)} / >=7d ${String(buckets.over7d)}`,
    ),
  );
  const state = backlog.byState;
  lines.push(
    `  状態別: 未着手 ${String(state.untouched)} / ` +
      `返答済み・未クローズ ${String(state.responded)} / ` +
      `委譲あり ${String(state.delegated)}${fold('progress:state-overlap', '（他と重なりうる）', '（重なりうる）')} / ` +
      `人間起点でない ${String(state.notApplicable)}` +
      (state.unjudgeable === undefined
        ? ''
        : ` / ${fold('progress:state-unjudgeable', '判定できない（会話に結んでいない）', '判定できない（未結合）')} ${String(state.unjudgeable)}`),
  );

  lines.push('', '実施中（委譲）');
  lines.push(
    `  実行中 ${String(inProgress.running)} / 人間待ち ${String(inProgress.awaitingHuman)} / ` +
      `行方不明 ${String(inProgress.lost)}`,
  );
  const lastReportTimes =
    `最古 ${at(inProgress.lastReport.oldestAt, now)} / ` +
    `最新 ${at(inProgress.lastReport.newestAt, now)} / `;
  const withoutReport = String(inProgress.lastReport.withoutReport);
  lines.push(
    fold(
      'progress:last-report',
      `  実行中の最終報告: ${lastReportTimes}報告無し ${withoutReport} 件`,
      `  最終報告: ${lastReportTimes}無し ${withoutReport} 件`,
    ),
  );

  const windowSpan = `${String(window.hours)} 時間: ${window.from} 〜 ${window.to}）`;
  lines.push(
    '',
    fold('progress:head-window', `窓の中の消化（直近 ${windowSpan}`, `窓（直近 ${windowSpan}`),
  );
  lines.push(
    `  台帳: 受けた ${String(throughput.commitmentsOpened)} 件 / 閉じた ${String(throughput.commitmentsClosed)} 件`,
  );
  const endedBasis = throughput.delegationsEnded.basis;
  lines.push(
    `  委譲の終了: ${String(throughput.delegationsEnded.count)} 件` +
      fold(
        'progress:ended-basis',
        `（basis: ${endedBasis} — 終端時刻の欄が無いので更新時刻での近似）`,
        `（basis: ${endedBasis}。更新時刻での近似）`,
      ),
  );

  lines.push('', '見込み');
  const basis = forecast.basis;
  switch (forecast.state) {
    case 'estimated':
      lines.push(`  推定: あと約 ${hours(forecast.hoursToDrain)}で未了が空になる`);
      lines.push(`  ${forecast.notice}`);
      break;
    case 'not_converging':
      lines.push(
        '  not_converging: 窓の中で流入が消化以上（受けた ' +
          `${String(basis.openedInWindow)} 件 / 閉じた ${String(basis.closedInWindow)} 件）。時間は出さない`,
      );
      break;
    case 'unavailable':
      lines.push(
        `  unavailable（${forecast.reason}）: ${UNAVAILABLE_REASONS[forecast.reason] ?? forecast.reason}。` +
          '時間は出さない',
      );
      break;
  }
  lines.push(
    fold(
      'progress:basis',
      `  根拠: 未了 ${String(basis.open)} / 窓で閉じた ${String(basis.closedInWindow)} / ` +
        `窓で受けた ${String(basis.openedInWindow)} / 窓 ${String(basis.windowHours)} 時間 / ${basis.method}`,
      `  根拠: 未了 ${String(basis.open)} / 閉 ${String(basis.closedInWindow)} / ` +
        `受 ${String(basis.openedInWindow)} / 窓 ${String(basis.windowHours)} 時間 / ${basis.method}`,
    ),
  );

  const { unreadable, trimmedClosed, unreadableJobs } = backlog.completeness;
  if (unreadable !== 0 || trimmedClosed !== 0) {
    lines.push(
      '',
      `※ 数が欠けうる（読めなかった行 ${String(unreadable)} 件 / 刈り取られた片付き行 ${String(trimmedClosed)} 件）`,
    );
  }
  // 欄が無い（古いデーモンの応答）ときは何も言わない: 「undefined 件」とも 0 件とも書かない。
  if (unreadableJobs !== undefined && unreadableJobs !== 0) {
    lines.push(
      '',
      `※ 読めない委譲の行が ${String(unreadableJobs)} 件ある。実施中・窓で終えた委譲・進行中（委譲あり）の数は、` +
        '読めた委譲の分しか数えていない（壊れた行であって、居ないのではない）',
    );
  }

  if (github.state !== 'not_observed') {
    lines.push(
      '',
      fold(
        'progress:github-heading',
        'GitHub: 観測した側の申告（デーモンは GitHub を見に行かず、値を確かめていない。古さは判定しない）',
        'GitHub: 観測した側の申告（値は未確認・古さは判定しない）',
      ),
    );
    for (const row of github.repos) {
      lines.push(`  ${row.repo}`);
      if (row.latestOk !== null) {
        const ok = row.latestOk;
        lines.push(
          `    open Issue ${String(ok.openIssues)} 件 / open PR ${String(ok.openPulls)} 件` +
            (ok.truncated ? '（limit に達した。実数はこれ以上）' : ''),
          `    観測: ${at(ok.observedAt, now)} 観測者 ${ok.observedBy} / 母集合 ${ok.query}` +
            (ok.limit === undefined ? '' : ` / limit ${String(ok.limit)}`),
        );
        lines.push(`    ${describeGithubCi(ok)}`);
      } else {
        lines.push(
          github.scan.reachedLimit
            ? `    数: — （読んだ範囲（新しい順 ${String(github.scan.limit)} 件）には成功した観測の記録が無い。0 件ではない）`
            : '    数: — （成功した観測の記録が無い。0 件ではない）',
        );
      }
      if (row.latestFailed !== null) {
        const failed = row.latestFailed;
        lines.push(
          `    取れなかった回: ${at(failed.observedAt, now)} 観測者 ${failed.observedBy} — ${failed.reason}`,
        );
      }
    }
    if (github.scan.reachedLimit) {
      lines.push(
        `  ※ 記録の読みが上限（新しい順 ${String(github.scan.limit)} 件）に当たった。古い記録にしか現れない repo は載っていない。載っている repo でも、成功・失敗の片方が読んだ範囲の外に押し出されて欠けていることがある`,
      );
    }
  }

  return lines.join('\n');
}
