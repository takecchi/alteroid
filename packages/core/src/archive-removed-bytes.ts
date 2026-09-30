/**
 * アーカイブ（退避した生ログ）の本文を消したときの「バイト数」に添える、
 * 単位の断り（Issue #2074 / PR #2076 の残り）。
 *
 * **消した量を人・エージェントへ出す口の唯一の正本である。** 口ごとに手で
 * 書くと、直した口と直さなかった口が混ざる（#2076 は `archive_remove_many` の
 * 1行だけを直し、単体削除の道具・CLI・記憶へ移せていない区間の申告が
 * 「N バイトを落とした」のまま残った）。
 *
 * 単位: `ArchiveRemoval` / `ArchiveRead` の `removed` の `bytes` は本文の素の
 * UTF-8 バイト数で、`ArchiveEntry.storedBytes`（置き場が実際に使っている量。
 * pg は TOAST 圧縮後）とは別の単位である。置き場で解放した量ではない
 * （pg では高圧縮な本文で約87倍。`store.ts` の `ArchiveRead` の doc）。
 *
 * 数の整形（桁区切りの有無）は口ごとの既存の見た目を変えないため、ここでは
 * 持たない。ここが持つのは断りの文言だけである。
 */
export const ARCHIVE_REMOVED_BYTES_UNIT_NOTE =
  '消した本文の素の UTF-8 バイト数。置き場で解放した量ではなく、storedBytes とは単位が違う';

/** 消したバイト数の直後に置く断り（括弧つき）。 */
export function describeArchiveRemovedBytesUnit(): string {
  return `（${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}）`;
}
