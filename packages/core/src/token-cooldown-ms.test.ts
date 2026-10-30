import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isTokenCooldownMs } from './token-cooldown-ms.js';
import { tokenRotationSettingsSchema } from './token-pool.js';

// daemon の PUT /tokens/policy の cooldownMs と同じ書き方（apps/daemon/src/openapi.ts）
const policyCooldownSchema = z.number().int().positive();

const CASES: unknown[] = [
  1,
  60_000,
  18_000_000,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  1e21,
  0,
  -0,
  -5,
  1.5,
  0.1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '1000',
  null,
  undefined,
  true,
  [],
  {},
];

describe('isTokenCooldownMs（#5903）', () => {
  it('daemon の zod スキーマと、同じ入力で同じ判定になる', () => {
    for (const value of CASES) {
      expect(isTokenCooldownMs(value), String(value)).toBe(
        policyCooldownSchema.safeParse(value).success,
      );
      expect(isTokenCooldownMs(value), String(value)).toBe(
        tokenRotationSettingsSchema.shape.cooldownMs.safeParse(value).success,
      );
    }
  });

  it('zod も node: も import しない（ブラウザの束に入れられる）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./token-cooldown-ms.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/from\s+'(zod|node:)/);
  });
});
