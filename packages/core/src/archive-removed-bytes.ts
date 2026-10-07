export const ARCHIVE_REMOVED_BYTES_UNIT_NOTE =
  '消した本文の素の UTF-8 バイト数。置き場で解放した量ではなく、storedBytes とは単位が違う';

export function describeArchiveRemovedBytesUnit(): string {
  return `（${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}）`;
}
