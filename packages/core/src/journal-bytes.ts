// core 内部の葉（公開入口にしない）。`logic/journal-summary.ts` の同じ式は、web バンドルを増やさないためインラインのまま残してある

/**
 * memory_update 行の「前後バイト数」を `前→後` の形にする。どちらかが無い行は `undefined`（呼び手が「不明（旧形式）」と書く）。
 * 旧形式 = `bytesBefore` / `bytesAfter` の欄を足す前に書かれた journal 行（DB に残る）。いつの形式かは履歴からは判らない。
 */
export function journalBytesChange(entry: {
  bytesBefore?: number | undefined;
  bytesAfter?: number | undefined;
}): string | undefined {
  return entry.bytesBefore === undefined || entry.bytesAfter === undefined
    ? undefined
    : `${entry.bytesBefore}→${entry.bytesAfter}`;
}
