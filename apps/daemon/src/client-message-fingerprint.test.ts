import { describe, expect, it } from 'vitest';

import { clientMessageFingerprint } from './client-message-fingerprint.js';

describe('clientMessageFingerprint', () => {
  it('陰性対照: 普通の本文は、別の本文と別の指紋になる', () => {
    expect(clientMessageFingerprint({ text: 'a' })).not.toBe(
      clientMessageFingerprint({ text: 'b' }),
    );
    expect(clientMessageFingerprint({ text: '絵文字😀' })).not.toBe(
      clientMessageFingerprint({ text: '絵文字�' }),
    );
  });

  it('指紋は JSON の配列 [本文, 並べた添付 id, supersedes] の sha256（hex 全長）で、値が固定されている', () => {
    expect(clientMessageFingerprint({ text: 'a' })).toBe(
      '8d1d190f5a1aab932bca8ad05f1089d41bbe026803e231621d4a7a92bddb7595',
    );
    expect(
      clientMessageFingerprint({ text: 't', attachmentIds: ['y', 'x', 'y'], supersedes: 'm' }),
    ).toBe('fd4ec630420afc4b974072b13a4e63c4719a58965792e4c05c4336333429c945');
  });

  it('孤立サロゲートは U+FFFD に直した本文と同じ指紋になる', () => {
    expect(clientMessageFingerprint({ text: 'x\ud83dy' })).toBe(
      clientMessageFingerprint({ text: 'x�y' }),
    );
    expect(clientMessageFingerprint({ text: 'a\u0000b\ude00' })).toBe(
      clientMessageFingerprint({ text: 'ab�' }),
    );
  });

  it('添付の id と supersedes にも同じ規則が掛かる', () => {
    expect(clientMessageFingerprint({ text: 't', attachmentIds: ['a\ud83d', 'b\u0000'] })).toBe(
      clientMessageFingerprint({ text: 't', attachmentIds: ['b', 'a�'] }),
    );
    expect(clientMessageFingerprint({ text: 't', supersedes: 'm\u0000\ud83d' })).toBe(
      clientMessageFingerprint({ text: 't', supersedes: 'm�' }),
    );
  });
});
