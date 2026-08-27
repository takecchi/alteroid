/**
 * `check-web-bundle-size.mjs` の判定だけを切り出したもの
 * （`check-web-bundle-node-traces-core.mjs` と同じ分け方）。
 *
 * **切り出したのはテストのためである。** 判定を CLI 側に置いたままだと、
 * 歯を試すには `pnpm build` から始まる一式を実際に走らせるしかなく、
 * **測りたいもの（閾値の判定ロジック）より桁違いに重いものを毎回走らせる
 * ことになる。** ここへ置けば、実ファイルを読まずに合成した `{ path, bytes }`
 * の配列で判定だけを試せる。**ファイル読み込みはしない**（読むのは CLI 側）。
 *
 * **閾値の数字の根拠・「言えないこと」の doc は `check-web-bundle-size.mjs`
 * が正本。** ここには閾値の定義と判定ロジックだけを置く。
 */

/**
 * 単一チャンクの上限（バイト）。256 KiB。
 *
 * **この値を変えるには、ここと `check-web-bundle-size.test.ts` の固定テストの
 * 両方を直す必要がある。** 片方だけ直すとテストが赤くなるので、「黙って上げる」
 * ができない（`check-web-bundle-size.test.ts` の doc）。根拠は `check-web-bundle-size.mjs`。
 */
export const SINGLE_CHUNK_MAX_BYTES = 262_144;

/**
 * `apps/web/build/client/assets/*.js` の合計の上限（バイト）。1 MiB。
 *
 * **この値を変えるには、ここと `check-web-bundle-size.test.ts` の固定テストの
 * 両方を直す必要がある。** 根拠は `check-web-bundle-size.mjs`。
 */
export const TOTAL_MAX_BYTES = 1_048_576;

/**
 * `files`（`{ path, bytes }` の配列）を閾値と突き合わせて判定する。
 *
 * ファイル読み込みは一切しない（呼ぶ側が既に読んだ大きさを渡す）。
 *
 * 返す形:
 * - `ok`: 単一チャンクの予算・総量の予算のどちらも超えていないか
 * - `sorted`: 大きい順に並べた全件（`{ path, bytes }`）
 * - `totalBytes`: 全件の合計バイト数
 * - `totalBudgetUsedPercent`: 総量の予算に対する使用率（%）
 * - `maxChunk`: 最大のチャンク（`sorted[0]`。`files` が空なら `undefined`）
 * - `singleBudgetUsedPercent`: 最大チャンクの、単一チャンクの予算に対する使用率（%）
 * - `oversized`: 単一チャンクの予算を超えたチャンクだけを大きい順に並べたもの。
 *   各要素は `{ path, bytes, overBytes, overPercent }`
 *   （`overBytes` / `overPercent` は予算からの超過分。予算未満なら `oversized` に現れない）
 * - `totalOver`: 総量が予算を超えたか
 */
export function judgeBundleSize(files) {
  const sorted = [...files].sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sorted.reduce((sum, f) => sum + f.bytes, 0);
  const oversized = sorted
    .filter((f) => f.bytes > SINGLE_CHUNK_MAX_BYTES)
    .map((f) => ({
      path: f.path,
      bytes: f.bytes,
      overBytes: f.bytes - SINGLE_CHUNK_MAX_BYTES,
      overPercent: ((f.bytes - SINGLE_CHUNK_MAX_BYTES) / SINGLE_CHUNK_MAX_BYTES) * 100,
    }));
  const totalOver = totalBytes > TOTAL_MAX_BYTES;
  const maxChunk = sorted[0];

  return {
    ok: oversized.length === 0 && !totalOver,
    sorted,
    totalBytes,
    totalBudgetUsedPercent: (totalBytes / TOTAL_MAX_BYTES) * 100,
    maxChunk,
    singleBudgetUsedPercent:
      maxChunk === undefined ? 0 : (maxChunk.bytes / SINGLE_CHUNK_MAX_BYTES) * 100,
    oversized,
    totalOver,
  };
}
