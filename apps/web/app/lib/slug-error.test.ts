import { describe, expect, it } from 'vitest';

import { describeSlugError } from './slug-error';

describe('describeSlugError', () => {
  it.each(['記憶', 'やり方'])('「%sのスラッグが不正」を、名前と使える形の文にする', (kind) => {
    const out = describeSlugError(new Error(`${kind}のスラッグが不正`));
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe(
      `${kind}の名前が使えない形。使えるのは半角の英小文字・数字と . _ - で、先頭は英数字。128 文字まで`,
    );
  });

  it('ほかの失敗・Error 以外の値はそのまま返す', () => {
    const other = new Error('サーバが断った');
    expect(describeSlugError(other)).toBe(other);
    expect(describeSlugError(undefined)).toBeUndefined();
    expect(describeSlugError('記憶のスラッグが不正')).toBe('記憶のスラッグが不正');
  });
});
