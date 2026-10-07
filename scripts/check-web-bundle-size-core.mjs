// 値を変えるには `check-web-bundle-size.test.ts` の固定テストも直す: 片方だけ直すとテストが赤くなり、黙って上げられないようにするため。
export const SINGLE_CHUNK_MAX_BYTES = 262_144;

export const TOTAL_MAX_BYTES = 1_179_648;

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
