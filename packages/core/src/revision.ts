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

import { z } from 'zod';

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

/**
 * いま走っているプロセスの版。
 *
 * **不変条件: `commit` と `short` は必ず揃って `null` になるか、揃って値を持つ。**
 * ただし `source` はそれとは独立に `null` になりうる——`commit`/`short` が値を
 * 持っていても `source` だけ `null` という組み合わせが実際に起きる（優先順位1
 * の焼き込み分岐で、`baked.revision` は非空なのに `baked.source` が `'build'` /
 * `'workspace'` のどちらでもないとき）。**「commit が在れば source も必ず在る」
 * とは読まないこと。** いまの `write-canon.mjs` は `''` / `'build'` /
 * `'workspace'` しか書かないのでこの組み合わせには実際には到達しないが、
 * `resolveBuildRevision` の実装は到達を許している——**返る値は正直**（「sha は
 * 分かるが出所の分類は分からない」）で、doc がそれより強い制限を書くと、次に
 * 読む人は「doc が嘘だ」と実装のほうを直しに行く。
 */
export interface BuildRevision {
  /**
   * フル sha（40桁）。取れなければ `null`。
   *
   * コミット sha は**秘密ではない**（公開リポジトリを指すポインタである）ので、
   * 伏せない。**この判断は「このリポジトリが公開である」という前提に乗っている。
   * 非公開になったら成り立たない。**（いまこの値が出るのは認証の内側だけ
   * ——`GET /runners` は認証必須、runner の `/health` は制御面の合鍵の内側
   * ——なので、この判断が実際に効いている場面は無い。**前提が変わったときに
   * 読む場所として置いてある。**）
   */
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
 * runner 1台についての版の報告。**器から返ってきた応答の中身だけを表す。**
 *
 * - `known` — 版が返ってきた
 * - `unknown` — 器には繋がった（`/health` が応答した）が、器自身が自分の版を
 *   知らない（`resolveBuildRevision` が全部 `null` を返した、または `revision`
 *   フィールド自体を持たない古い runner）
 *
 * **「そもそも訊けていない」はここには無い。** それは応答の中身ではなく
 * 「応答が無かった」ことなので、この型の外（呼び出し側 — 名簿を持つ
 * `runner-protocol.ts` の `RunnerRevisionStatus`）でしか判定できない。
 */
export type RunnerRevisionReport =
  | { status: 'known'; commit: string; short: string; source: RevisionSource }
  | { status: 'unknown' };

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
