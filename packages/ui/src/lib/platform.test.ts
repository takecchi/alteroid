import { describe, expect, it } from 'vitest';

import { isMacPlatform, submitShortcutLabel } from './platform';

describe('isMacPlatform', () => {
  it('userAgentData.platform を先に見る', () => {
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(
      false,
    );
  });
  it('userAgentData が無ければ navigator.platform を見る', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'iPhone' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false);
  });
  it('取れないとき（SSR・空・未対応）は Ctrl 側（false）', () => {
    expect(isMacPlatform(null)).toBe(false);
    expect(isMacPlatform({})).toBe(false);
    expect(isMacPlatform({ platform: '' })).toBe(false);
  });
});

describe('submitShortcutLabel', () => {
  it('OS に合わせた修飾キーの表記', () => {
    expect(submitShortcutLabel(true)).toBe('⌘ + Enter');
    expect(submitShortcutLabel(false)).toBe('Ctrl + Enter');
  });
});
