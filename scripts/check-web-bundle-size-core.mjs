// 値を変えるには `check-web-bundle-size.test.ts` の固定テストも直す: 片方だけ直すとテストが赤くなり、黙って上げられないようにするため。
export const SINGLE_CHUNK_MAX_BYTES = 262_144;

// 1.25 MiB。2026-10-07 オーナー決定。main が予算の 99% に来ていて、画面を足す PR が全部落ちる状態だったため。
// 2026-10-29 オーナー決定で一時的に 4 KiB 上げていた（1_310_720 → 1_314_816）のを、台帳の画面（commitments のチャンク）を消した #5469 P7 の段3で戻した。
// 2026-11-07 React Router 7 → 8（#6563）で +16 KiB（1_310_720 → 1_327_104）。依頼元が手当てを任せ、ALT-DEV-V が上げると決めた。
// 実測: v7 の main は 1,290,673 B（98%）、v8 は 1,305,678 B（100%。残り約 5 KB）。増えた約 15 KB のほとんどは v8 の本体で
// （最大のチャンクだけで +8.3 KB）、v8 で既定になった splitRouteModules の分は 559 B だけ（切っても手当てにならない）。
// 上げ幅は、上げる前に main が持っていた余白（約 20 KB）を保つ幅にした。
export const TOTAL_MAX_BYTES = 1_327_104;

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
