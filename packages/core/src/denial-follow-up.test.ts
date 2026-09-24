import { describe, expect, it } from 'vitest';

import { describeDenialFollowUp } from './manager.js';

/**
 * 「止められた後に委譲が報告を返したか」を3値のどれかで言う（issue #1455）。
 *
 * **3値を畳まないことがこの関数の本題である。** 時刻の取れていない拒否を
 * 「届いていない」側へも「届いている」側へも寄せない。
 */
describe('describeDenialFollowUp（#1455）', () => {
  const T1 = '2026-09-24T07:00:00.000Z';
  const T2 = '2026-09-24T07:05:00.000Z';
  const T3 = '2026-09-24T07:10:00.000Z';

  it('拒否が無ければ何も言わない', () => {
    expect(describeDenialFollowUp([], T3)).toBeNull();
  });

  it('最後の拒否より後に報告が在れば「届いている」と言い、越えたかまでは言わない', () => {
    const text = describeDenialFollowUp([{ lastAt: T1 }, { lastAt: T2 }], T3);
    expect(text).toContain(`最後に止められた（${T2}）後にも報告が届いている（${T3}）`);
    expect(text).toContain('越えたかまでは見ていない');
  });

  it('報告が無い、または最後の拒否より前なら「まだ届いていない」', () => {
    expect(describeDenialFollowUp([{ lastAt: T2 }], undefined)).toBe(
      `最後に止められた（${T2}）後の報告はまだ届いていない`,
    );
    // 報告は在るが、最後の拒否（T3）より前（T1）—— 拒否の後の動きではない。
    expect(describeDenialFollowUp([{ lastAt: T2 }, { lastAt: T3 }], T1)).toBe(
      `最後に止められた（${T3}）後の報告はまだ届いていない`,
    );
    // 同時刻は「後」ではない。
    expect(describeDenialFollowUp([{ lastAt: T2 }], T2)).toContain('まだ届いていない');
  });

  it('⭐ 時刻の取れていない拒否が1件でも在れば「判定できない」—— どちらへも畳まない', () => {
    const text = describeDenialFollowUp([{ lastAt: T1 }, {}], T3);
    expect(text).toContain('判定できない');
    expect(text).not.toContain('届いている');
    expect(text).not.toContain('まだ届いていない');
  });
});
