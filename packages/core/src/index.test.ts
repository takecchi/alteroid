import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from './index.js';

describe('@alteroid/core', () => {
  it('テストハーネスが動作する（M0 スモーク）', () => {
    expect(CORE_VERSION).toBe('0.0.0');
  });
});
