import * as generatedCanon from './generated/canon.js';
import type { BuildRevision, RunnerRevisionReport } from './revision-format.js';

const { CANON_REVISION, CANON_REVISION_SOURCE } = generatedCanon;

export interface BakedCanonRevision {
  revision: string;
  source: string;
}

/**
 * 本番コードはこの既定値だけを使う。`resolveBuildRevision` の第2引数 `baked` はテストが
 * `vi.mock` なしで「焼き込みが無い」を再現するためだけに在り、本番の経路は渡さない。
 */
const REAL_BAKED_REVISION: BakedCanonRevision = {
  revision: CANON_REVISION,
  source: CANON_REVISION_SOURCE,
};

function shortOf(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * 優先順位は焼き込み > `ALTEROID_BUILD_REV` > `RAILWAY_GIT_COMMIT_SHA`（焼き込みだけがイメージの中身の証拠）。
 * 環境変数は呼び出し時に読む: モジュール読み込み時に固定するとテストで差し替えられない。
 */
export function resolveBuildRevision(
  env: NodeJS.ProcessEnv = process.env,
  baked: BakedCanonRevision = REAL_BAKED_REVISION,
): BuildRevision {
  if (baked.revision.length > 0) {
    const source = baked.source === 'build' || baked.source === 'workspace' ? baked.source : null;
    return { commit: baked.revision, short: shortOf(baked.revision), source };
  }

  const runtimeBuildRev = (env.ALTEROID_BUILD_REV ?? '').trim();
  if (runtimeBuildRev.length > 0) {
    return { commit: runtimeBuildRev, short: shortOf(runtimeBuildRev), source: 'env' };
  }

  const platformSha = (env.RAILWAY_GIT_COMMIT_SHA ?? '').trim();
  if (platformSha.length > 0) {
    return { commit: platformSha, short: shortOf(platformSha), source: 'platform' };
  }

  return { commit: null, short: null, source: null };
}

export function reportRunnerRevision(rev: BuildRevision): RunnerRevisionReport {
  if (rev.commit === null || rev.short === null || rev.source === null) {
    return { status: 'unknown' };
  }
  return { status: 'known', commit: rev.commit, short: rev.short, source: rev.source };
}
