import { describe, expect, it } from 'vitest';

import { cooldownUntilFrom, decideTokenRotation } from './token-rotation.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';

/**
 * 「いま回すか」の判定（Issue #393 PR3）。
 *
 * **ここが固定するのは受け入れ基準そのものである** — Issue の追記2 が
 * 「設定が `off` なら1本も回らない」「`free_exhausted` なら `rejected` だけで回る」
 * 「`overage_exhausted` なら `rejected` だけでは回らない」を受け入れ基準に足しており、
 * 受け入れ基準9 が「`org_policy` では回さない」を要求している。
 */

const reached: UsageLimitNotice = {
  kind: 'reached',
  text: "You've hit your org's monthly spend limit",
};
const orgPolicy: UsageLimitNotice = {
  kind: 'org_policy',
  text: 'This service is disabled for your org',
};
const warning: UsageLimitNotice = { kind: 'warning', text: "You've used 90% of your weekly limit" };

/** 課金枠が生きている（閉じていると読める印が1つも無い）事実。 */
const overageAlive: RateLimitFacts = { kind: 'five_hour', status: 'rejected', usingOverage: true };
/** 課金枠も閉じている事実。 */
const overageRejected: RateLimitFacts = {
  kind: 'five_hour',
  status: 'rejected',
  overageStatus: 'rejected',
};

describe('設定が off（受け入れ基準: 1本も回らない）', () => {
  it('仕事が止まっていても回さない', () => {
    const d = decideTokenRotation('off', { notice: reached });
    expect(d.rotate).toBe(false);
    expect(d.why).toContain('off');
  });

  it('枠から追い返されても回さない', () => {
    expect(
      decideTokenRotation('off', { transition: 'rejected', facts: overageRejected }).rotate,
    ).toBe(false);
  });

  it('回さないときも、何を見ていたかの印は残す（none へ潰さない）', () => {
    // 潰すと日誌から「近づいていたのか、何も無かったのか」が消える。
    expect(decideTokenRotation('off', { notice: reached }).signal).toBe('reached');
    expect(
      decideTokenRotation('off', { transition: 'rejected', facts: overageRejected }).signal,
    ).toBe('overage_closed');
  });
});

describe('組織の方針（受け入れ基準9: 回さない。記録だけ）', () => {
  it('どの設定でも回さない', () => {
    for (const policy of ['free_exhausted', 'overage_exhausted', 'off'] as const) {
      const d = decideTokenRotation(policy, { notice: orgPolicy });
      expect(d.rotate, policy).toBe(false);
      expect(d.signal, policy).toBe('org_policy');
    }
  });

  it('回しても直らないことを理由に書く（待っても直らない、だけではない）', () => {
    // ここで回すと、プールを1周ぶん食って同じところで止まる。
    expect(decideTokenRotation('free_exhausted', { notice: orgPolicy }).why).toContain(
      '別のトークンでも同じ組織なら同じ結果',
    );
  });

  it('枠の事実が同時に来ていても、組織の方針が優先される', () => {
    // 判定の順序そのもの。`rejected` を先に見ると回ってしまう。
    const d = decideTokenRotation('free_exhausted', {
      notice: orgPolicy,
      transition: 'rejected',
      facts: overageRejected,
    });
    expect(d.rotate).toBe(false);
    expect(d.signal).toBe('org_policy');
  });
});

describe('free_exhausted（既定。課金枠を焼く前に回す）', () => {
  it('rejected だけで回る（受け入れ基準）', () => {
    const d = decideTokenRotation('free_exhausted', {
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected' },
    });
    expect(d.rotate).toBe(true);
    expect(d.signal).toBe('quota_rejected');
  });

  it('課金枠から引き始めた瞬間でも回る', () => {
    const d = decideTokenRotation('free_exhausted', {
      transition: 'entered_overage',
      facts: { kind: 'five_hour', usingOverage: true },
    });
    expect(d.rotate).toBe(true);
    expect(d.signal).toBe('entered_overage');
  });

  it('接近警告では回らない', () => {
    const d = decideTokenRotation('free_exhausted', { notice: warning });
    expect(d.rotate).toBe(false);
    expect(d.signal).toBe('warning');
  });

  it('材料が何も無ければ回らない', () => {
    const d = decideTokenRotation('free_exhausted', {});
    expect(d.rotate).toBe(false);
    expect(d.signal).toBe('none');
  });

  it('状態ではなく遷移で判定する（同じ rejected で毎ターン回さない）', () => {
    // `rate_limit_event` はターンの頭ごとに来る。事実だけ渡って遷移が無いのは
    // 「もう知らせた」状態であり、ここで回すと1回の当たりでプールを食い潰す。
    const d = decideTokenRotation('free_exhausted', { facts: overageRejected });
    expect(d.rotate).toBe(false);
  });
});

describe('overage_exhausted（課金枠まで使ってから回す）', () => {
  it('rejected だけでは回らない（受け入れ基準）', () => {
    // **ここが追記1の訂正の本体である。** `rejected` は「その枠1つが尽きた」で
    // あって「もう通らない」ではない。課金枠が生きているのに回すと、人間が
    // 意図して使っている課金枠を捨てることになる。
    const d = decideTokenRotation('overage_exhausted', {
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected' },
    });
    expect(d.rotate).toBe(false);
    expect(d.why).toContain('課金枠が生きている限り回さない');
  });

  it('課金枠が生きている（usingOverage: true）なら回らない', () => {
    expect(
      decideTokenRotation('overage_exhausted', { transition: 'rejected', facts: overageAlive })
        .rotate,
    ).toBe(false);
  });

  it('課金枠も閉じていれば回る（overageStatus）', () => {
    const d = decideTokenRotation('overage_exhausted', {
      transition: 'rejected',
      facts: overageRejected,
    });
    expect(d.rotate).toBe(true);
    expect(d.signal).toBe('overage_closed');
  });

  it('課金枠も閉じていれば回る（overageDisabledReason が在る）', () => {
    const d = decideTokenRotation('overage_exhausted', {
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected', overageDisabledReason: 'out_of_credits' },
    });
    expect(d.rotate).toBe(true);
    expect(d.signal).toBe('overage_closed');
  });

  it('課金枠へ入っただけでは回らない（まだ動いている）', () => {
    expect(decideTokenRotation('overage_exhausted', { transition: 'entered_overage' }).rotate).toBe(
      false,
    );
  });
});

describe('reached は off 以外のどちらの設定でも回る', () => {
  /**
   * **これは実装側の推論である**（Issue の表には `free_exhausted` の側に
   * `reached` が挙がっていない）。`free_exhausted` は `overage_exhausted` より
   * 弱い契機で回す設定なので、**より強い観測で回らないのは矛盾する。**
   */
  it('free_exhausted でも overage_exhausted でも回る', () => {
    for (const policy of ['free_exhausted', 'overage_exhausted'] as const) {
      const d = decideTokenRotation(policy, { notice: reached });
      expect(d.rotate, policy).toBe(true);
      expect(d.signal, policy).toBe('reached');
    }
  });
});

describe('「取れなかった」を「閉じている」と読まない', () => {
  it('usingOverage: false は「引けない」ではないので、課金枠が閉じたと読まない', () => {
    // あれは「いま引いていない」である。閉じたと読むと、overage_exhausted の
    // 設定で課金枠を1円も使わずに回ってしまう。
    const d = decideTokenRotation('overage_exhausted', {
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected', usingOverage: false },
    });
    expect(d.rotate).toBe(false);
  });

  it('課金枠について何も観測が無いときも、閉じたと読まない', () => {
    const d = decideTokenRotation('overage_exhausted', {
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected' },
    });
    expect(d.rotate).toBe(false);
  });
});

describe('冷却の期限を事実から取る', () => {
  it('枠そのものの resetsAt を優先する', () => {
    // 逆順にすると、無料枠が先に開くのに課金枠のリセットまで寝ることになる。
    expect(cooldownUntilFrom({ resetsAt: 1_000, overageResetsAt: 9_000 })).toBe(1_000);
  });

  it('枠の resetsAt が無ければ課金枠のほうを採る', () => {
    expect(cooldownUntilFrom({ overageResetsAt: 9_000 })).toBe(9_000);
  });

  it('取れなければ undefined（既定を関数の中に持たない）', () => {
    // 呼ぶ側が設定の既定へ倒す。ここに固定値を持つと、設定を変えたのに
    // 片方の経路だけ古い値で動く形が作れる。
    expect(cooldownUntilFrom({ kind: 'five_hour', status: 'rejected' })).toBeUndefined();
    expect(cooldownUntilFrom(undefined)).toBeUndefined();
  });

  it('過去の値を未来へ丸めない', () => {
    // 既に過ぎていれば「もう戻っている」が正しい（`markTokenUnusable` の doc）。
    expect(cooldownUntilFrom({ resetsAt: 1 })).toBe(1);
  });
});
