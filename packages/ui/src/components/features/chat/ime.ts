import type { KeyboardEvent } from 'react';

export function isImeConfirmEnter(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && isImeComposing(event);
}

export function isImeComposing(event: KeyboardEvent): boolean {
  // `event.nativeEvent.isComposing` を見る: React の合成イベントの型は `isComposing` を持たないため
  // `keyCode === 229` も併せて見る: `isComposing` を立てずに変換確定の Enter を配る実装が在るため
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

export function isSubmitShortcut(event: KeyboardEvent): boolean {
  if (isImeConfirmEnter(event)) return false;
  return (event.metaKey || event.ctrlKey) && event.key === 'Enter';
}

export function isPlatformSubmitShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (!isSubmitShortcut(event)) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
