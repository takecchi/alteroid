/**
 * `clientMessageFingerprint` の正規化（#3634）。本文・添付の id・`supersedes` に、pg の日誌が残す形
 * （NUL を落とし、孤立サロゲートを U+FFFD に置き換える）と同じ規則が掛かる。
 */
import { describe, expect, it } from 'vitest';

import { clientMessageFingerprint } from './client-message-fingerprint.js';

describe('clientMessageFingerprint', () => {
  it('陰性対照: 普通の本文は、別の本文と別の指紋になる', () => {
    expect(clientMessageFingerprint({ text: 'a' })).not.toBe(clientMessageFingerprint({ text: 'b' }));
    expect(clientMessageFingerprint({ text: '絵文字😀' })).not.toBe(
      clientMessageFingerprint({ text: '絵文字�' }),
    );
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
