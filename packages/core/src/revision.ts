/**
 * 実行時に「いまの版」を解決する唯一の場所。
 *
 * **なぜ要るのか。** デーモン（app）と runner は別の Service で別々にビルド・
 * デプロイされる（`railway/daemon.json` / `railway/runner.json`）。同じ `main`
 * から起こしていても、デプロイのタイミングがずれれば**別のコミットで走る窓**が
 * できる。その窓でだけ壊れるものは、両者が自分の版を名乗れて初めて見つかる。
 *
 * **これは計器である。「取れなかった」を「取れた」に見せてはいけない。** 埋まら
 * なかったときに既定値・プレースホルダ・腐る値（前回のリリースの sha 等）を
 * 絶対に返さない。全部 `null` に倒し、表示は `describeBuildRevision` が
 * 「不明」に倒す。
 */

import { CANON_REVISION, CANON_REVISION_SOURCE } from './generated/canon.js';

/**
 * どこから取れた値か。
 *
 * - `'build'` — `ALTEROID_BUILD_REV` を焼き込み時に渡された（`write-canon.mjs`）
 * - `'workspace'` — 焼き込み時の git 作業ツリーから `git rev-parse HEAD` で拾った
 * - `'env'` — 実行時の `ALTEROID_BUILD_REV`（人間が手で置いた値）
 * - `'platform'` — 実行時の `RAILWAY_GIT_COMMIT_SHA`（Railway がデプロイごとに注入）
 */
export type RevisionSource = 'build' | 'workspace' | 'env' | 'platform';

/** いま走っているプロセスの版。全項目が揃うか、全項目が `null` かのどちらかである。 */
export interface BuildRevision {
  /** フル sha（40桁）。取れなければ `null`。 */
  commit: string | null;
  /** 表示用の短縮。取れなければ `null`。 */
  short: string | null;
  source: RevisionSource | null;
}

/** 焼き込み値（`CANON_REVISION` / `CANON_REVISION_SOURCE`）の形。 */
interface BakedCanonRevision {
  revision: string;
  source: string;
}

/**
 * 実際にビルドで焼かれた値。**本番コードはこの既定値だけを使う。**
 *
 * `resolveBuildRevision` の第2引数は、テストが `vi.mock` に頼らずに「焼き込みが
 * 無かったら」を再現するためだけに存在する（このリポジトリは `vi.mock` より
 * 実引数の差し替えを好む — `packages/core/src/runner-registry.test.ts` 冒頭の
 * コメント参照）。渡さなければ常にこれが使われる。
 */
const REAL_BAKED_REVISION: BakedCanonRevision = {
  revision: CANON_REVISION,
  source: CANON_REVISION_SOURCE,
};

function shortOf(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * いま走っているプロセスの版を解決する。
 *
 * **優先順位（上が勝つ）:**
 *
 * 1. 焼き込み（`CANON_REVISION` / `CANON_REVISION_SOURCE`）— **イメージに入って
 *    いるコードそのものの証拠なので最も強い。** ビルドしたときの中身と、いま
 *    走っているコードが同一であることまで保証する。
 * 2. 実行時の `ALTEROID_BUILD_REV` → `source: 'env'` — 人間が手で置いた値。
 *    ビルド後にいくらでも書き換えられるので、**イメージの中身の証拠にはならない**
 *    （焼き込みより弱く扱う）。
 * 3. 実行時の `RAILWAY_GIT_COMMIT_SHA` → `source: 'platform'` — 器（Railway）
 *    自身がそのデプロイの出所を名乗っている値。人間が手で置いたものではないので
 *    `env` より器の外形に近いが、それでも「実際にビルドされたイメージの中身」の
 *    証拠ではないので焼き込みには劣る。
 * 4. どれも無い → 全項目 `null`。
 *
 * **環境変数は呼び出し時に読む**（モジュール読み込み時に固定しない）。凍らせると
 * テストで差し替えられず、`Dockerfile` の ARG が実際に効いたかどうかも実行時に
 * しか分からない値（`RAILWAY_GIT_COMMIT_SHA` 等）を読み違える。
 */
export function resolveBuildRevision(
  env: NodeJS.ProcessEnv = process.env,
  baked: BakedCanonRevision = REAL_BAKED_REVISION,
): BuildRevision {
  // 1. 焼き込み。
  if (baked.revision.length > 0) {
    const source = baked.source === 'build' || baked.source === 'workspace' ? baked.source : null;
    return { commit: baked.revision, short: shortOf(baked.revision), source };
  }

  // 2. 実行時に人間が置いた値。
  const runtimeBuildRev = (env.ALTEROID_BUILD_REV ?? '').trim();
  if (runtimeBuildRev.length > 0) {
    return { commit: runtimeBuildRev, short: shortOf(runtimeBuildRev), source: 'env' };
  }

  // 3. 器（Railway）がデプロイごとに注入する値。
  const platformSha = (env.RAILWAY_GIT_COMMIT_SHA ?? '').trim();
  if (platformSha.length > 0) {
    return { commit: platformSha, short: shortOf(platformSha), source: 'platform' };
  }

  // 4. 取れなかった。**プレースホルダを作らない。**
  return { commit: null, short: null, source: null };
}

const SOURCE_LABEL: Record<RevisionSource, string> = {
  build: 'イメージに焼き込み済み',
  workspace: 'ビルド時の作業ツリーから取得',
  env: '実行時に ALTEROID_BUILD_REV で指定',
  platform: 'Railway が実行時に注入',
};

/**
 * 人間 / クローン向けの1行。**「不明」に倒すのがここの唯一の仕事である。**
 *
 * 取れなかったときに、それらしい既定値やハイフンではなく明示的に「不明」と言う。
 */
export function describeBuildRevision(rev: BuildRevision): string {
  if (rev.commit === null || rev.short === null || rev.source === null) {
    return 'リビジョン: 不明（焼き込み・実行時の環境変数のどちらからも取れなかった）';
  }
  return `リビジョン: ${rev.short}（${SOURCE_LABEL[rev.source]}、フル ${rev.commit}）`;
}
