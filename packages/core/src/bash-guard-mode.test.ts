import { describe, expect, it } from 'vitest';

import {
  BASH_GUARD_ENV,
  BASH_GUARD_VALUES,
  BASH_SHAPE_GUARD_ENV,
  DEFAULT_BASH_GUARD,
  DEFAULT_BASH_SHAPE_GUARD,
  describeBashShapeGuard,
  resolveBashGuardMode,
  resolveBashShapeGuard,
  resolveEffectiveBashShapeGuard,
} from './bash-guard-mode.js';

describe('resolveBashShapeGuard（#4949）', () => {
  it('未設定・空・空白は既定（off）', () => {
    expect(DEFAULT_BASH_SHAPE_GUARD).toBe('off');
    expect(resolveBashShapeGuard({})).toBe('off');
    expect(resolveBashShapeGuard({ [BASH_SHAPE_GUARD_ENV]: ' ' })).toBe('off');
  });

  it('on / off を読む。綴り違いは投げる', () => {
    expect(resolveBashShapeGuard({ [BASH_SHAPE_GUARD_ENV]: ' on ' })).toBe('on');
    expect(resolveBashShapeGuard({ [BASH_SHAPE_GUARD_ENV]: 'off' })).toBe('off');
    expect(() => resolveBashShapeGuard({ [BASH_SHAPE_GUARD_ENV]: 'ON' })).toThrow(
      /ALTEROID_BASH_SHAPE_GUARD の値が不正: ON（使えるのは on \/ off。既定は off）/,
    );
  });

  it('実効の値はプロファイルが優先で、空なら runner の env', () => {
    const on = { [BASH_SHAPE_GUARD_ENV]: 'on' };
    const off = { [BASH_SHAPE_GUARD_ENV]: 'off' };
    expect(resolveEffectiveBashShapeGuard(on, {})).toBe('on');
    expect(resolveEffectiveBashShapeGuard(on, off)).toBe('off');
    expect(resolveEffectiveBashShapeGuard({}, on)).toBe('on');
    expect(resolveEffectiveBashShapeGuard(on, { [BASH_SHAPE_GUARD_ENV]: '' })).toBe('on');
    expect(() => resolveEffectiveBashShapeGuard({}, { [BASH_SHAPE_GUARD_ENV]: 'x' })).toThrow();
  });

  it('起動行は on / off を言い、不正な値でも投げずに不正と書く', () => {
    expect(describeBashShapeGuard({}, {})).toBe(
      'Bash の形の歯: off（ALTEROID_BASH_SHAPE_GUARD。runner の env の値。実行環境プロファイルに置けばそちらが優先される）',
    );
    expect(describeBashShapeGuard({}, { [BASH_SHAPE_GUARD_ENV]: 'on' })).toBe(
      'Bash の形の歯: on（ALTEROID_BASH_SHAPE_GUARD。実行環境プロファイルの値。runner の env より優先される）',
    );
    const bad = describeBashShapeGuard({ [BASH_SHAPE_GUARD_ENV]: 'maybe' }, {});
    expect(bad).toContain('不正な値');
    expect(bad).toContain('maybe');
  });
});

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
