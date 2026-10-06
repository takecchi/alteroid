import { useSyncExternalStore } from 'react';

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

const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

function subscribeTouchOnly(notify: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const query = window.matchMedia(TOUCH_ONLY_QUERY);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}

function readTouchOnly(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(TOUCH_ONLY_QUERY).matches
  );
}

/**
 * キーボードの案内（「⌘ + Enter で送信」など）を出してよいか。
 *
 * **指だけの端末**（`(pointer: coarse)` かつ `(hover: none)`）では出さない（物理キーが無い）。
 * hover か fine pointer が在れば出す。**`matchMedia` が無い環境（SSR・jsdom）では出す側。**
 */
export function useKeyboardHintsVisible(): boolean {
  return !useSyncExternalStore(subscribeTouchOnly, readTouchOnly, () => false);
}
