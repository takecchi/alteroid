import { describe, expect, it } from 'vitest';

import {
  categoryFromRefusalText,
  describeRefusalFailureMark,
  looksLikeSafeguardsRefusal,
  resolveRefusalAutoReopen,
} from './clone-refusal.js';

describe('resolveRefusalAutoReopen', () => {
  it('未設定・空白は有効（既定）', () => {
    expect(resolveRefusalAutoReopen({})).toEqual({ enabled: true });
    expect(resolveRefusalAutoReopen({ ALTEROID_REFUSAL_AUTO_REOPEN: '  ' })).toEqual({
      enabled: true,
    });
  });

  it('off / false / 0 で外れ、on で有効', () => {
    for (const value of ['off', 'OFF', ' false ', '0', 'no', 'disabled']) {
      expect(resolveRefusalAutoReopen({ ALTEROID_REFUSAL_AUTO_REOPEN: value }).enabled).toBe(false);
    }
    expect(resolveRefusalAutoReopen({ ALTEROID_REFUSAL_AUTO_REOPEN: 'on' })).toEqual({
      enabled: true,
    });
  });

  it('読めない綴りは有効のまま、その綴りを返す（投げない・黙らない）', () => {
    expect(resolveRefusalAutoReopen({ ALTEROID_REFUSAL_AUTO_REOPEN: 'Maybe' })).toEqual({
      enabled: true,
      unrecognized: 'maybe',
    });
  });
});

describe('拒否の判定の部品', () => {
  it('looksLikeSafeguardsRefusal は大小を無視する', () => {
    expect(looksLikeSafeguardsRefusal("Opus 5.5's Safeguards Flagged this session")).toBe(true);
    expect(looksLikeSafeguardsRefusal('rate limited')).toBe(false);
  });

  it('categoryFromRefusalText は Details: [x] だけを拾う', () => {
    expect(categoryFromRefusalText('… Details: [cyber]')).toBe('cyber');
    expect(categoryFromRefusalText('no details')).toBeNull();
  });

  it('印は category が無ければ「不明」', () => {
    expect(describeRefusalFailureMark('cyber')).toBe('（safeguards: cyber）');
    expect(describeRefusalFailureMark(null)).toBe('（safeguards: 不明）');
  });
});
