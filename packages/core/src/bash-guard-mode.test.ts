import { describe, expect, it } from 'vitest';

import {
  BASH_GUARD_ENV,
  BASH_GUARD_VALUES,
  DEFAULT_BASH_GUARD,
  resolveBashGuardMode,
} from './bash-guard-mode.js';

describe('resolveBashGuardMode（#2884）', () => {
  it('未設定・空・空白は既定（ask）', () => {
    expect(DEFAULT_BASH_GUARD).toBe('ask');
    expect(resolveBashGuardMode({})).toBe('ask');
    expect(resolveBashGuardMode({ [BASH_GUARD_ENV]: '' })).toBe('ask');
    expect(resolveBashGuardMode({ [BASH_GUARD_ENV]: '  ' })).toBe('ask');
  });

  it('ask / deny / off をそのまま読む（前後の空白は落とす）', () => {
    for (const value of BASH_GUARD_VALUES) {
      expect(resolveBashGuardMode({ [BASH_GUARD_ENV]: ` ${value} ` })).toBe(value);
    }
  });

  it('綴り違いは黙って既定へ倒さず落とす（使える値を言う）', () => {
    expect(() => resolveBashGuardMode({ [BASH_GUARD_ENV]: 'of' })).toThrow(
      /ALTEROID_BASH_GUARD の値が不正: of（使えるのは ask \/ deny \/ off。既定は ask）/,
    );
    expect(() => resolveBashGuardMode({ [BASH_GUARD_ENV]: 'ASK' })).toThrow();
  });
});
