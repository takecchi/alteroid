import { describe, expect, it } from 'vitest';

import { tokensHref } from './tokens-links.js';

describe('tokensHref（issue #2109）', () => {
  it('tokenId を渡すと /tokens?tokenId=<id> になる', () => {
    expect(tokensHref({ tokenId: 'tok-1' })).toBe('/tokens?tokenId=tok-1');
  });

  it('何も渡さないと絞り込み無しの /tokens になる', () => {
    expect(tokensHref()).toBe('/tokens');
    expect(tokensHref({})).toBe('/tokens');
  });

  it('空文字は「その欄は載せない」——絞り込みを消す form と同じ規約', () => {
    expect(tokensHref({ tokenId: '' })).toBe('/tokens');
  });
});
