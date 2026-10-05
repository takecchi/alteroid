import { describe, expect, it } from 'vitest';

import { describeCliVersion } from './version.js';

describe('alteroid --version（#2857）', () => {
  it('焼かれた sha を、短縮・フル・出所つきで出す（0.1.0 の固定ではない）', () => {
    const text = describeCliVersion({
      commit: '17002bafbeb5a1b2c3d4e5f60718293a4b5c6d7e',
      short: '17002bafbeb5',
      source: 'build',
    });
    expect(text).toContain('alteroid 17002bafbeb5');
    expect(text).toContain('17002bafbeb5a1b2c3d4e5f60718293a4b5c6d7e');
    expect(text).not.toContain('0.1.0');
  });

  it('取れないときは「不明」と言い、それらしい版を作らない', () => {
    const text = describeCliVersion({ commit: null, short: null, source: null });
    expect(text).toContain('不明');
    expect(text).toContain('ALTEROID_BUILD_REV');
    expect(text).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('出所が分類できなくても sha は出す', () => {
    expect(
      describeCliVersion({ commit: 'abcdef1234567890', short: 'abcdef123456', source: null }),
    ).toBe('alteroid abcdef123456（フル abcdef1234567890）');
  });
});
