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
 *
 * **型と言い方は隣の `revision-format.ts` に在る**（`@alteroid/core/revision` として
 * ブラウザへ出す軽い口。ここは焼き込みと zod を読むので画面からは読ませられない）。
 * 既存の呼び出し側のために、このファイルからもそのまま再 export する。
 */

import { z } from 'zod';

import * as generatedCanon from './generated/canon.js';
import type { BuildRevision, BuildTime, RunnerRevisionReport } from './revision-format.js';

export {
  describeBuildAge,
  describeBuildRevision,
  describeRevisionStatus,
  revisionSourceLabel,
  type BuildRevision,
  type BuildTime,
  type RevisionSource,
  type RunnerRevisionReport,
} from './revision-format.js';

const { CANON_REVISION, CANON_REVISION_SOURCE } = generatedCanon;

/**
 * `CANON_BUILT_AT` を**名前つき import にしない**（#1226）。
 *
 * `write-canon.mjs` の `builtAt()` の doc が言うとおり、この変更より前に焼かれた
 * イメージの `generated/canon.ts` にはこの定数そのものが無い。名前つき import
 * （`import { CANON_BUILT_AT } from ...`）は、無い名前を静的に要求する形なので、
 * モジュール解決によってはロード時エラーになりうる。名前空間 import
 * （`import * as generatedCanon`）なら、無くても単に `undefined` になるだけで
 * 読み込み自体は落ちない——「無い＝不明」に倒す先が、ここで確保される。
 */
const bakedBuiltAt: string = (generatedCanon as { CANON_BUILT_AT?: string }).CANON_BUILT_AT ?? '';

/** 焼き込み値（`CANON_REVISION` / `CANON_REVISION_SOURCE`）の形。 */
interface BakedCanonRevision {
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
 * このイメージが**焼かれた時刻**を解決する（#1226）。
 *
 * **`resolveBuildRevision` と違い、出所は1つしか無い**（焼き込みのみ——実行時の
 * 環境変数で上書きできる経路はいまのところ無い）。**⚠️ だから `env` 引数は
 * 持たない**——設計の下書きは `resolveBuildRevision` と同じ `(env, baked)` の
 * 並びを例示していたが、`env` を読まない実装で仮引数だけ置くと、この repo の
 * lint（`@typescript-eslint/no-unused-vars`）がデフォルト値つき引数を未使用と
 * して落とす（実測: 早期 return の有無に関わらず、デフォルト値を持つ引数は
 * 位置に関係なく使用を要求される——`after-used` の除外は無引数値の場合にしか
 * 効かない）。使われない仮引数を"将来のため"に残す形は、AGENTS.md
 * 「取れない軸に0の行を作る」と同じ族（無い実体をそれらしい形で埋める）なので
 * 採らない。将来、実行時の上書き経路（例: `ALTEROID_BUILD_AT`）を足すときに
 * この第1引数を追加すること。
 *
 * **空・壊れた値（`Date.parse` が `NaN`）は `null` に倒す。** 「取れなかった」を
 * 「取れた」に見せない、というこのファイル冒頭の約束と同じ——古い焼き込み
 * （`CANON_BUILT_AT` が無い）・空文字・壊れた文字列のどれであっても同じ `null`
 * へ倒れる。読む側（`describeBuildAge`）はこの3つを区別する必要が無い。
 *
 * `baked`（引数）の効力の範囲は `REAL_BAKED_REVISION` の doc と同じ
 * ——テスト専用で、**本番の経路はどこからも渡さない。**
 */
export function resolveBuildTime(baked: string = bakedBuiltAt): BuildTime {
  const value = baked.trim();
  if (value.length === 0) return { builtAt: null };
  if (Number.isNaN(Date.parse(value))) return { builtAt: null };
  return { builtAt: value };
}

/**
 * `BuildRevision` の wire 形（`GET /health` が返す JSON の中身）。
 *
 * **信用しない側から使う。** runner が返した JSON はネットワーク越しの入力であり、
 * 形が壊れていても（版違いの runner・改造された応答）落ちずに扱えること。
 * `.safeParse` に通す側（`apps/daemon/src/runner-client.ts`）が使う。
 */
export const buildRevisionSchema = z.object({
  commit: z.string().min(1).nullable(),
  short: z.string().min(1).nullable(),
  source: z.enum(['build', 'workspace', 'env', 'platform']).nullable(),
});

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
