/**
 * 送信のショートカットの修飾キーが ⌘（macOS・iOS 系）か Ctrl（それ以外）かを決める。
 *
 * `navigator.userAgentData.platform`（取れるブラウザ）→ `navigator.platform` の順に見る。
 * **取れないとき（SSR・テスト・古い環境）は Ctrl 側**（`false`）。
 */
export interface PlatformSource {
  userAgentData?: { platform?: string };
  platform?: string;
}

export function isMacPlatform(
  source: PlatformSource | null = typeof navigator === 'undefined' ? null : navigator,
): boolean {
  const name = source?.userAgentData?.platform ?? source?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(name);
}

/** 送信ショートカットの表示名。 */
export function submitShortcutLabel(mac: boolean): string {
  return mac ? '⌘ + Enter' : 'Ctrl + Enter';
}
