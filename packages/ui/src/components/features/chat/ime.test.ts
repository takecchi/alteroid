import type { KeyboardEvent } from 'react';
import { describe, expect, it } from 'vitest';

import * as ime from './ime';

function keyEvent(
  over: Partial<{
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    keyCode: number;
  }>,
): KeyboardEvent {
  const { isComposing = false, keyCode = 13, ...rest } = over;
  return {
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    ...rest,
    nativeEvent: { isComposing, keyCode },
  } as unknown as KeyboardEvent;
}

describe('isSubmitShortcut', () => {
  it('⌘ + Enter でも Ctrl + Enter でも送る（OS で分けない）', () => {
    expect(ime.isSubmitShortcut(keyEvent({ metaKey: true }))).toBe(true);
    expect(ime.isSubmitShortcut(keyEvent({ ctrlKey: true }))).toBe(true);
  });

  it('修飾キーの無い Enter と、Enter 以外のキーでは送らない', () => {
    expect(ime.isSubmitShortcut(keyEvent({}))).toBe(false);
    expect(ime.isSubmitShortcut(keyEvent({ key: 'a', metaKey: true }))).toBe(false);
  });

  it('変換確定の Enter では送らない（isComposing / keyCode 229）', () => {
    expect(ime.isSubmitShortcut(keyEvent({ metaKey: true, isComposing: true }))).toBe(false);
    expect(ime.isSubmitShortcut(keyEvent({ ctrlKey: true, keyCode: 229 }))).toBe(false);
  });

  // 送る規則は1つだけ: OS ごとに分ける別の規則を残すと、どちらが効いているかが読めなくなる
  it('OS ごとに分ける別の規則を持たない', () => {
    expect(Object.keys(ime)).not.toContain('isPlatformSubmitShortcut');
  });
});
