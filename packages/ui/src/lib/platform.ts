import { useSyncExternalStore } from 'react';

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

export function useKeyboardHintsVisible(): boolean {
  return !useSyncExternalStore(subscribeTouchOnly, readTouchOnly, () => false);
}
