/**
 * 同じ精度・同じタイムゾーン（`toISOString()`）で書かれた値どうしなので、文字列比較が時刻の比較と一致する
 * （`describeDenialFollowUp` と同じ前提）。読めない値を渡さないこと。
 */
export function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}
