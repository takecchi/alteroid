import { describe, expect, it } from 'vitest';

import { placedModelTier, resolveModelTier } from './model-tier.js';

describe('placedModelTier', () => {
  it('置かれていなければ null（空・空白も未設定）', () => {
    expect(placedModelTier({}, 'ALTEROID_MANAGER_MODEL')).toBeNull();
    expect(placedModelTier({ ALTEROID_MANAGER_MODEL: '' }, 'ALTEROID_MANAGER_MODEL')).toBeNull();
    expect(placedModelTier({ ALTEROID_MANAGER_MODEL: ' ' }, 'ALTEROID_MANAGER_MODEL')).toBeNull();
  });

  it('置かれていれば前後の空白を落とした値', () => {
    expect(placedModelTier({ ALTEROID_MANAGER_MODEL: ' opus ' }, 'ALTEROID_MANAGER_MODEL')).toBe(
      'opus',
    );
  });
});

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
