import type { JournalEntry } from './schema.js';

/** 日誌から読む `github_observation` の件数の上限（新しい順）。 */
export const GITHUB_OBSERVATION_SCAN_LIMIT = 500;

export interface GithubObservationCi {
  /** CI を見た PR の数（open PR の総数とは別）。 */
  pulls: number;
  success: number;
  failure: number;
  pending: number;
  /** 何を数えたか（必須チェックだけ・check の名前の列挙など）。 */
  checks: string;
  /** 真なら上限で打ち切っており、数は下限。 */
  truncated?: boolean;
}

export interface GithubObservationOk {
  /** デーモンが記録を受けた時刻（観測した側の時計ではない）。 */
  observedAt: string;
  /** 観測した側の名乗り。デーモンは確かめていない。 */
  observedBy: string;
  /** 母集合の切り方（`gh issue list ...` の引数など）。 */
  query: string;
  limit?: number;
  openIssues: number;
  openPulls: number;
  /** 真なら `limit` に達しており、数は下限。 */
  truncated: boolean;
  /** 無ければ CI を観測していない（0 件の意味ではない）。`ciUnavailable` と排他。 */
  ci?: GithubObservationCi;
  /** CI を取れなかった理由（観測した側の申告）。`ci` と排他。 */
  ciUnavailable?: string;
}

export interface GithubObservationFailed {
  observedAt: string;
  observedBy: string;
  query: string;
  limit?: number;
  /** 観測した側が書いた取れなかった理由（申告）。 */
  reason: string;
}

export interface GithubRepoObservation {
  repo: string;
  /** その repo の最新の成功。無ければ `null`（0 件の意味ではない）。 */
  latestOk: GithubObservationOk | null;
  /** その repo の最新の失敗。無ければ `null`。 */
  latestFailed: GithubObservationFailed | null;
}

export type ProgressGithub =
  | { state: 'not_observed'; reason: string }
  | {
      state: 'observed';
      /** repo の名前順。 */
      repos: GithubRepoObservation[];
      scan: { limit: number; reachedLimit: boolean };
    };

/** 記録が1件も無いとき（0 件の意味ではない）。 */
export const PROGRESS_GITHUB_NOT_OBSERVED = {
  state: 'not_observed',
  reason:
    'GitHub（Issue / PR / CI）の数を観測した記録がまだ無い。デーモンは GitHub を見に行かない' +
    '（観測した側が記録した数だけを返す）ため、ここに数が無いのは 0 件という意味ではない。',
} as const;

/**
 * `entries` は新しい順で渡すこと（先に見つかった成功・失敗を最新として採る）。
 * `scanLimit + 1` 件まで渡すこと: 「先が在る」は読めた行数 >= 上限では決められない
 * （pg は SQL の `LIMIT` の後で形の合わない行を捨てうる）ので、`scanLimit + 1` 件目の有無で見る。
 */
export function summarizeGithubObservations(
  entries: readonly JournalEntry[],
  scanLimit: number = GITHUB_OBSERVATION_SCAN_LIMIT,
): ProgressGithub {
  const byRepo = new Map<string, GithubRepoObservation>();
  let seen = 0;
  let more = false;
  for (const entry of entries) {
    if (entry.type !== 'github_observation') continue;
    seen += 1;
    if (seen > scanLimit) {
      more = true;
      break;
    }
    let row = byRepo.get(entry.repo);
    if (row === undefined) {
      row = { repo: entry.repo, latestOk: null, latestFailed: null };
      byRepo.set(entry.repo, row);
    }
    const common = {
      observedAt: entry.at,
      observedBy: entry.observedBy,
      query: entry.query,
      ...(entry.limit === undefined ? {} : { limit: entry.limit }),
    };
    if (entry.result.status === 'ok') {
      row.latestOk ??= {
        ...common,
        openIssues: entry.result.openIssues,
        openPulls: entry.result.openPulls,
        truncated: entry.result.truncated,
        ...(entry.result.ci === undefined ? {} : { ci: entry.result.ci }),
        ...(entry.result.ciUnavailable === undefined
          ? {}
          : { ciUnavailable: entry.result.ciUnavailable }),
      };
    } else {
      row.latestFailed ??= { ...common, reason: entry.result.reason };
    }
  }
  if (byRepo.size === 0) return PROGRESS_GITHUB_NOT_OBSERVED;
  return {
    state: 'observed',
    repos: [...byRepo.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)),
    scan: { limit: scanLimit, reachedLimit: more },
  };
}

/** `ci` が無いときは `success 0 / failure 0` と書かない: 0 件と読めてしまうから。 */
export function describeGithubCi(ok: Pick<GithubObservationOk, 'ci' | 'ciUnavailable'>): string {
  if (ok.ci !== undefined) {
    const ci = ok.ci;
    const counted = ci.success + ci.failure + ci.pending;
    return (
      `CI: ${String(ci.pulls)} 件の PR を確認 — success ${String(ci.success)} / failure ${String(ci.failure)} / pending ${String(ci.pending)}` +
      (counted < ci.pulls ? `（チェックが無い等で未集計 ${String(ci.pulls - counted)} 件）` : '') +
      `（数えたもの: ${ci.checks}）` +
      (ci.truncated === true ? '（打ち切り。数は下限）' : '')
    );
  }
  if (ok.ciUnavailable !== undefined)
    return `CI: 取れなかった — ${ok.ciUnavailable}（0 件ではない）`;
  return 'CI: 観測していない（0 件ではない）';
}
