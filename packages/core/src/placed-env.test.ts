import { describe, expect, it } from 'vitest';

import { placedEnvValue } from './placed-env.js';

describe('placedEnvValue', () => {
  it('置かれていなければ null（空・空白も未設定）', () => {
    expect(placedEnvValue({}, 'ALTEROID_MANAGER_MODEL')).toBeNull();
    expect(placedEnvValue({ ALTEROID_MANAGER_MODEL: '' }, 'ALTEROID_MANAGER_MODEL')).toBeNull();
    expect(placedEnvValue({ ALTEROID_MANAGER_MODEL: ' ' }, 'ALTEROID_MANAGER_MODEL')).toBeNull();
  });

  it('置かれていれば前後の空白を落とした値（値の検査はしない）', () => {
    expect(placedEnvValue({ ALTEROID_MANAGER_MODEL: ' opus ' }, 'ALTEROID_MANAGER_MODEL')).toBe(
      'opus',
    );
    expect(
      placedEnvValue(
        { ALTEROID_CLONE_PERMISSION_MODE: 'strict' },
        'ALTEROID_CLONE_PERMISSION_MODE',
      ),
    ).toBe('strict');
  });
});
