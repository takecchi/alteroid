import { describe, expect, it } from 'vitest';

import { usageHref } from './usage-links';

describe('usageHref（issue #2077 / #2078）', () => {
  it('managerId だけ渡すと /usage?managerId=<id> になる', () => {
    expect(usageHref({ managerId: 'mgr-1' })).toBe('/usage?managerId=mgr-1');
  });

  it('from/to だけ渡すと /usage?from=<from>&to=<to> になる（この順で載る）', () => {
    expect(usageHref({ from: '2026-08-14', to: '2026-08-14' })).toBe(
      '/usage?from=2026-08-14&to=2026-08-14',
    );
  });

  it('全部渡すと3つとも載る', () => {
    expect(usageHref({ from: '2026-08-01', to: '2026-08-20', managerId: 'm1' })).toBe(
      '/usage?from=2026-08-01&to=2026-08-20&managerId=m1',
    );
  });

  it('何も渡さないと絞り込み無しの /usage になる', () => {
    expect(usageHref()).toBe('/usage');
    expect(usageHref({})).toBe('/usage');
  });

  it('空文字は「その欄は載せない」——絞り込みを消す form と同じ規約', () => {
    expect(usageHref({ from: '', to: '', managerId: '' })).toBe('/usage');
    expect(usageHref({ managerId: 'm1', from: '' })).toBe('/usage?managerId=m1');
  });
});
