/**
 * 版の解決と報告（issue #2860。`revision.ts` から分けた、zod を持たない側）。
 *
 * `resolveBuildRevision` / `reportRunnerRevision` は焼き込み値（`generated/canon.ts`）
 * と環境変数だけを読む純粋な処理で、zod のスキーマとは無関係である。CLI の
 * `--version` が `@alteroid/core/cli-light` 経由で読めるよう、zod を引く
 * `revision.ts` から分けた。`revision.ts` はここから再 export するので、
 * `@alteroid/core` の公開面は変わらない。
 */

import * as generatedCanon from './generated/canon.js';
import type { BuildRevision, RunnerRevisionReport } from './revision-format.js';

const { CANON_REVISION, CANON_REVISION_SOURCE } = generatedCanon;

/** 焼き込み値（`CANON_REVISION` / `CANON_REVISION_SOURCE`）の形。 */
export interface BakedCanonRevision {
  revision: string;
  source: string;
}

/**
 * 実際にビルドで焼かれた値。**本番コードはこの既定値だけを使う。**
 *
 * `resolveBuildRevision` の第2引数（`baked`）は、テストが `vi.mock` に頼らずに
 * 「焼き込みが無かったら」を再現するためだけに存在する（このリポジトリは
 * `vi.mock` より実引数の差し替えを好む — `packages/core/src/runner-registry.test.ts`
 * 冒頭のコメント参照）。渡さなければ常にこれが使われる。
 *
 * **この第2引数は焼き込みが無かった場合を再現するためだけに在る。本番の経路は
 * どこからも渡さない。**（これは「渡してよい設定」ではない。渡す実装が現れたら、
 * それは本番の形が変わったということである。）
 *
 * **内部に閉じていない。** `resolveBuildRevision` は `packages/core/src/index.ts`
 * から export されているので、この第2引数は `@alteroid/core` の**公開 API**に
 * 含まれる（`private: true` で npm へは publish されないが、ワークスペース内の
 * daemon / runner / cli / storage-* からは見える範囲）。呼び出し側で `baked` を
 * 渡すコードが増えたら、それはこの契約が破られたサインである。
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
 *
 * `baked`（第2引数）の効力の範囲は `REAL_BAKED_REVISION` の doc を見ること
 * ——テスト専用で、本番の経路はどこからも渡さない。
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

/**
 * `BuildRevision` を `RunnerRevisionReport` へ畳む。
 *
 * **`unheard`（名乗りをまだ聞けていない）はここでは作れない。** 引数は「応答が
 * 返ってきた」ことが前提の値なので、応答そのものが無かったことはこの関数の外
 * （`packages/core/src/runner-protocol.ts` の `RunnerRevisionStatus`）でしか
 * 分からない。
 */
export function reportRunnerRevision(rev: BuildRevision): RunnerRevisionReport {
  if (rev.commit === null || rev.short === null || rev.source === null) {
    return { status: 'unknown' };
  }
  return { status: 'known', commit: rev.commit, short: rev.short, source: rev.source };
}
