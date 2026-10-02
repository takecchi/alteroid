/**
 * 進捗の集計（`readProgress` の結果）を、読める文へ（Issue #2241 の 3）。
 *
 * **CLI（`alteroid progress`）とクローンの道具（`progress_read`）が同じ関数を使う。**
 * 口ごとに言い回しが違うと、読む側は別の状態だと読む。元は `apps/cli/src/progress.ts` の
 * `renderProgress`（出力は1文字も変えていない）。
 *
 * **数え直さない・作らない。** 数は `summarizeProgress` が出したものをそのまま並べる。
 * 率（%）は作らない（台帳に総量が無く分母が定まらない）。**取れないものは 0 と書かない**
 * （`null` は「—」、見込みが `unavailable` / `not_converging` なら状態と理由を言って時間は作らない）。
 * Node 専用のものは持ち込まない（web 向けバンドルに載りうる）。
 */
import { formatElapsedAgo } from './format-elapsed.js';
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

/**
 * `describeProgress` が受ける形。`ProgressView`（デーモンが返す型。変えない）と違い、
 * `completeness.unreadableJobs` だけが任意——後から足した欄（issue #2345）なので、
 * 古いデーモンの応答には無い（CLI は応答を型で検査せず、そのまま渡す。issue #2382）。
 * `ProgressView` はこの型にそのまま代入できる。
 */
export type ProgressViewInput = Omit<ProgressView, 'backlog'> & {
  backlog: Omit<ProgressView['backlog'], 'completeness'> & {
    completeness: Omit<ProgressView['backlog']['completeness'], 'unreadableJobs'> & {
      unreadableJobs?: number;
    };
  };
};

/**
 * 進捗の集計を、人間が読める形へ。**率（%）は出さない。**
 */
export function describeProgress(view: ProgressViewInput): string {
  const { window, backlog, inProgress, throughput, forecast, github, observedAt } = view;
  const now = new Date(observedAt).getTime();
  const lines: string[] = [];

  lines.push(`観測時刻: ${observedAt}`);

  lines.push('', `積み上がり（台帳の未了）: ${String(backlog.total)} 件`);
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
    `    1時間未満 ${String(buckets.under1h)} / 24時間未満 ${String(buckets.under24h)} / ` +
      `7日未満 ${String(buckets.under7d)} / 7日以上 ${String(buckets.over7d)}`,
  );
  const state = backlog.byState;
  lines.push(
    `  状態別: 未着手 ${String(state.untouched)} / 返答済み・未クローズ ${String(state.responded)} / ` +
      `委譲あり ${String(state.delegated)}（他と重なりうる） / 人間起点でない ${String(state.notApplicable)}`,
  );

  lines.push('', '実施中（委譲）');
  lines.push(
    `  実行中 ${String(inProgress.running)} / 人間待ち ${String(inProgress.awaitingHuman)} / ` +
      `行方不明 ${String(inProgress.lost)}`,
  );
  lines.push(
    `  実行中の最終報告: 最古 ${at(inProgress.lastReport.oldestAt, now)} / ` +
      `最新 ${at(inProgress.lastReport.newestAt, now)} / 報告無し ${String(inProgress.lastReport.withoutReport)} 件`,
  );

  lines.push(
    '',
    `窓の中の消化（直近 ${String(window.hours)} 時間: ${window.from} 〜 ${window.to}）`,
  );
  lines.push(
    `  台帳: 受けた ${String(throughput.commitmentsOpened)} 件 / 閉じた ${String(throughput.commitmentsClosed)} 件`,
  );
  lines.push(
    `  委譲の終了: ${String(throughput.delegationsEnded.count)} 件` +
      `（basis: ${throughput.delegationsEnded.basis} — 終端時刻の欄が無いので更新時刻での近似）`,
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
    `  根拠: 未了 ${String(basis.open)} / 窓で閉じた ${String(basis.closedInWindow)} / ` +
      `窓で受けた ${String(basis.openedInWindow)} / 窓 ${String(basis.windowHours)} 時間 / ${basis.method}`,
  );

  const { unreadable, trimmedClosed, unreadableJobs } = backlog.completeness;
  if (unreadable !== 0 || trimmedClosed !== 0) {
    lines.push(
      '',
      `※ 数が欠けうる（読めなかった行 ${String(unreadable)} 件 / 刈り取られた片付き行 ${String(trimmedClosed)} 件）`,
    );
  }
  // 委譲の行の欠け（issue #2345）。0 件なら行を作らない（上の行と同じ作法）。
  // 欄が無い（古いデーモンの応答。issue #2382）ときも何も言わない——「undefined 件」と書かず、
  // 0 件とも言わない（Web の `progress.tsx` と同じ）。
  if (unreadableJobs !== undefined && unreadableJobs !== 0) {
    lines.push(
      '',
      `※ 読めない委譲の行が ${String(unreadableJobs)} 件ある。実施中・窓で終えた委譲・進行中（委譲あり）の数は、` +
        '読めた委譲の分しか数えていない（壊れた行であって、居ないのではない）',
    );
  }

  if (github.state === 'not_observed') {
    lines.push('', `GitHub: 観測していない（0 件ではない）— ${github.reason}`);
  } else {
    lines.push(
      '',
      'GitHub: 観測した側の申告（デーモンは GitHub を見に行かず、値を確かめていない。古さは判定しない）',
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
      } else {
        lines.push('    数: — （成功した観測の記録が無い。0 件ではない）');
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
        `  ※ 記録の読みが上限（${String(github.scan.limit)} 件）に当たった。古い記録にしか現れない repo は載っていない`,
      );
    }
  }

  return lines.join('\n');
}
