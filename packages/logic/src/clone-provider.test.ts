import { describe, expect, it } from 'vitest';

import { CLONE_PROVIDER_UNKNOWN_LABEL, describeCloneProvider } from './clone-provider.js';

describe('describeCloneProvider（#486 S9）', () => {
  it('デーモンが返した provider id はそのまま出す', () => {
    expect(describeCloneProvider('claude')).toBe('claude');
  });

  it('欄が無い（undefined / null / 空）ときは claude と推測せず「不明」と書く', () => {
    for (const absent of [undefined, null, '']) {
      const text = describeCloneProvider(absent);
      expect(text).toBe(CLONE_PROVIDER_UNKNOWN_LABEL);
      expect(text).not.toContain('claude');
      expect(text).toContain('不明');
    }
  });
});
