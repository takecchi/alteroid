/** 保存の開始を待つ猶予。大きいファイルでも開始は数秒で済むので、余裕を見て 40 秒。 */
const REVOKE_DELAY_MS = 40_000;

/** `Blob` を `a[download]` で保存する（チャットの添付と「ファイル」画面で共有する）。 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // click の直後に同期で revoke すると、ブラウザが保存を始める前に URL が無効になり、
  // 空のファイルや失敗になることがある。保存の開始に足りる猶予を置く。
  // タイマーは effect に結ばず、アンマウント後も走らせる（clear すると URL が漏れる）。
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
