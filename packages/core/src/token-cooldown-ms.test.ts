import { describe, expect, it } from 'vitest';

import { tokenCooldownMsSchema } from './token-cooldown-ms.js';
import { tokenRotationSettingsSchema } from './token-pool.js';

describe('tokenCooldownMsSchema（#5903）', () => {
  it('正の整数だけを通す', () => {
    expect(tokenCooldownMsSchema.safeParse(1).success).toBe(true);
    expect(tokenCooldownMsSchema.safeParse(18_000_000).success).toBe(true);
    expect(tokenCooldownMsSchema.safeParse(0).success).toBe(false);
    expect(tokenCooldownMsSchema.safeParse(-5).success).toBe(false);
    expect(tokenCooldownMsSchema.safeParse(1.5).success).toBe(false);
  });

  it('保存する設定の cooldownMs も同じ規則を使う', () => {
    for (const value of [0, -5, 1.5, 60_000]) {
      expect(tokenRotationSettingsSchema.shape.cooldownMs.safeParse(value).success).toBe(
        tokenCooldownMsSchema.safeParse(value).success,
      );
    }
  });
});
