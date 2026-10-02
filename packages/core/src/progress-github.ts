/**
 * `GET /progress` の `github` ——誰かが観測して日誌へ置いた GitHub の数を、repo ごとに
 * 組んで返す（Issue #2245 段1）。
 *
 * **デーモンは GitHub を見に行かない**（`schema.ts` の `JobStatus` の doc「デーモンは PR も
 * ブランチも見に行かない」）。ここにあるのは「観測した側が名乗った申告」の置き直しで、
 * 値の正しさは確かめていない。だから `observedBy` を落とさず、読み手へそのまま渡す。
 *
 * - **repo ごとに最新の1件**を、成功（`latestOk`）と失敗（`latestFailed`）で別々に持つ。
 *   失敗のほうが新しいことは時刻の比べで読める。**失敗の回に数は無い**ので、直前の成功の
 *   数を失敗の回へ写さない（取れなかった回に数を作らない）。
 * - **古さは判定しない。** `observedAt`（デーモンが記録を受けた時刻）をそのまま返す。
 * - 記録が1件も無ければ `not_observed`（0 件ではない）。
 * - 日誌の読みは新しい順に `scanLimit` 件まで。**上限に当たったら `scan.reachedLimit` が真**で、
 *   それより古い記録にしか現れない repo や、その repo の古い側の記録は載っていない。
 */
import type { JournalEntry } from './schema.js';

/** 日誌から読む `github_observation` の件数の上限（新しい順）。 */
export const GITHUB_OBSERVATION_SCAN_LIMIT = 500;

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
 * 日誌の `github_observation` を repo ごとに畳む。**`entries` は新しい順**（`JournalStore.list`
 * の既定）で渡すこと——先に見つかった成功・失敗をその repo の最新として採る。
 * 他の種別が混ざっていても読み飛ばす。
 */
export function summarizeGithubObservations(
  entries: readonly JournalEntry[],
  scanLimit: number = GITHUB_OBSERVATION_SCAN_LIMIT,
): ProgressGithub {
  const byRepo = new Map<string, GithubRepoObservation>();
  let seen = 0;
  for (const entry of entries) {
    if (entry.type !== 'github_observation') continue;
    seen += 1;
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
      };
    } else {
      row.latestFailed ??= { ...common, reason: entry.result.reason };
    }
  }
  if (byRepo.size === 0) return PROGRESS_GITHUB_NOT_OBSERVED;
  return {
    state: 'observed',
    repos: [...byRepo.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)),
    scan: { limit: scanLimit, reachedLimit: seen >= scanLimit },
  };
}
