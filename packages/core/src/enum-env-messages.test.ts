import { describe, expect, it } from 'vitest';

import { resolvePermissionModeFor } from './permission-mode.js';
import { resolveMemoryGuard } from './tools.js';

// 「env の値を候補から選び、綴り違いなら投げる」読み方の文言を全文で縛る（#5660。試験の無かった2つ）
describe('resolveMemoryGuard', () => {
  it('未設定・空・空白は既定（on）。候補の値は前後の空白を落として読む', () => {
    expect(resolveMemoryGuard({})).toBe('on');
    expect(resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: '' })).toBe('on');
    expect(resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: '  ' })).toBe('on');
    expect(resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: ' off ' })).toBe('off');
  });

  it('綴り違いは既定へ倒さず、候補と既定を添えて投げる', () => {
    expect(() => resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: 'OFF' })).toThrow(
      'ALTEROID_MEMORY_GUARD の値が不正: OFF（使えるのは on / off。既定は on）',
    );
  });
});

describe('resolvePermissionModeFor', () => {
  it('綴り違いは既定へ倒さず、候補と既定を添えて投げる', () => {
    expect(() => resolvePermissionModeFor({ SOME_KEY: ' strict ' }, 'SOME_KEY')).toThrow(
      'SOME_KEY の値が不正: strict（使えるのは default / acceptEdits / bypassPermissions / plan / dontAsk / auto。既定は auto）',
    );
  });
});
