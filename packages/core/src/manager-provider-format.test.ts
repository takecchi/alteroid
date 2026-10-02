import { describe, expect, it } from 'vitest';

import {
  describeManagerProvider,
  MANAGER_PROVIDER_UNKNOWN_LABEL,
} from './manager-provider-format.js';

describe('describeManagerProvider（#486 S9）', () => {
  it('名乗られた provider id はそのまま出す', () => {
    expect(describeManagerProvider('claude')).toBe('claude');
    expect(describeManagerProvider('codex')).toBe('codex');
  });

  it('欄が無い（undefined / null / 空）ときは claude と推測せず「不明」と書く', () => {
    for (const absent of [undefined, null, '']) {
      const text = describeManagerProvider(absent);
      expect(text).toBe(MANAGER_PROVIDER_UNKNOWN_LABEL);
      expect(text).not.toContain('claude');
      expect(text).toContain('不明');
    }
  });
});
