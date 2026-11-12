import { describe, expect, it } from 'vitest';

import { describeTokenHolders } from './token.js';

describe('alteroid token list の「使用中」（#6646）', () => {
  const holders = [
    { tokenId: 'a', kind: 'clone' },
    { tokenId: 'a', kind: 'manager', managerId: 'mgr-01ad099a-3525' },
    { tokenId: 'b', kind: 'manager', managerId: 'mgr-b4d06dc6-8f45' },
  ] satisfies Parameters<typeof describeTokenHolders>[0];

  it('その鍵で動いている担当を並べる（委譲は地図と同じ頭8文字）', () => {
    expect(describeTokenHolders(holders, 'a')).toBe('使用中: クローン / mgr-01ad');
    expect(describeTokenHolders(holders, 'b')).toBe('使用中: mgr-b4d0');
  });

  it('誰も使っていない鍵は、そう言う', () => {
    expect(describeTokenHolders(holders, 'c')).toBe('使用中: いまこの鍵で動いている担当は無い');
  });
});
