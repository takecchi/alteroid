import { describe, expect, it } from 'vitest';

import { resolveModelTier } from './model-tier.js';

describe('resolveModelTier', () => {
  it('置かれていなければ既定、置かれていれば置いた値', () => {
    expect(
      resolveModelTier({ ALTEROID_MANAGER_MODEL: ' ' }, 'ALTEROID_MANAGER_MODEL', 'sonnet'),
    ).toBe('sonnet');
    expect(
      resolveModelTier({ ALTEROID_MANAGER_MODEL: 'opus' }, 'ALTEROID_MANAGER_MODEL', 'sonnet'),
    ).toBe('opus');
  });
});
