import { describe, expect, it } from 'vitest';

import {
  cooldownUntilFrom,
  decideTokenRotation,
  earliestRememberedCooldown,
  observationFreshness,
  selectNextToken,
} from './token-rotation.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';

const reached: UsageLimitNotice = {
  kind: 'reached',
  text: "You've hit your org's monthly spend limit",
};
const orgPolicy: UsageLimitNotice = {
  kind: 'org_policy',
  text: 'This service is disabled for your org',
};
const warning: UsageLimitNotice = { kind: 'warning', text: "You've used 90% of your weekly limit" };

const overageAlive: RateLimitFacts = { kind: 'five_hour', status: 'rejected', usingOverage: true };
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
    expect(decideTokenRotation('free_exhausted', { notice: orgPolicy }).why).toContain(
      '別のトークンでも同じ組織なら同じ結果',
    );
  });

  it('枠の事実が同時に来ていても、組織の方針が優先される', () => {
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
    const d = decideTokenRotation('free_exhausted', { facts: overageRejected });
    expect(d.rotate).toBe(false);
  });
});

describe('overage_exhausted（課金枠まで使ってから回す）', () => {
  it('rejected だけでは回らない（受け入れ基準）', () => {
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

describe('#668: 状態でも回る（ただし観測がいまの世代を名乗ったときだけ）', () => {
  const restated = { facts: overageRejected, statusNow: 'rejected' } as const;

  it('いまの世代を名乗る観測なら、遷移が無くても回る', () => {
    const d = decideTokenRotation('free_exhausted', restated, 'current');
    expect(d.rotate).toBe(true);
    expect(d.signal).toBe('overage_closed');
  });

  it('遷移で回った回と、状態で回った回を日誌で見分けられる', () => {
    const byTransition = decideTokenRotation(
      'free_exhausted',
      { transition: 'rejected', facts: overageRejected },
      'current',
    );
    const byState = decideTokenRotation('free_exhausted', restated, 'current');
    expect(byState.why).not.toBe(byTransition.why);
    expect(byState.why).toContain('いまの世代を名乗っている');
  });

  it('⚠️ 身元を運ばない観測（unknown）では状態で回さない', () => {
    const d = decideTokenRotation('free_exhausted', restated, 'unknown');
    expect(d.rotate).toBe(false);
  });

  it('世代が合わない観測（stale）でも回さない', () => {
    expect(decideTokenRotation('free_exhausted', restated, 'stale').rotate).toBe(false);
  });

  it('freshness を渡さない呼び方では回らない（従来どおり遷移だけ）', () => {
    expect(decideTokenRotation('free_exhausted', restated).rotate).toBe(false);
  });

  it('重ねた形の status では回らない（statusNow だけを見る）', () => {
    const d = decideTokenRotation('free_exhausted', { facts: overageRejected }, 'current');
    expect(d.rotate).toBe(false);
  });

  it('allowed を運ぶ観測では回らない', () => {
    const d = decideTokenRotation(
      'free_exhausted',
      { facts: { kind: 'five_hour', status: 'allowed' }, statusNow: 'allowed' },
      'current',
    );
    expect(d.rotate).toBe(false);
  });

  it('off なら状態でも回らない（人間が自動を切った意思）', () => {
    expect(decideTokenRotation('off', restated, 'current').rotate).toBe(false);
  });

  it('org_policy なら状態でも回らない（受け入れ基準9）', () => {
    const d = decideTokenRotation('free_exhausted', { ...restated, notice: orgPolicy }, 'current');
    expect(d.rotate).toBe(false);
    expect(d.signal).toBe('org_policy');
  });

  it('overage_exhausted では、課金枠が生きているかぎり状態でも回らない', () => {
    const d = decideTokenRotation(
      'overage_exhausted',
      { facts: overageAlive, statusNow: 'rejected' },
      'current',
    );
    expect(d.rotate).toBe(false);
  });

  it('overage_exhausted でも、課金枠まで閉じていれば状態で回る', () => {
    const d = decideTokenRotation('overage_exhausted', restated, 'current');
    expect(d.rotate).toBe(true);
    expect(d.signal).toBe('overage_closed');
  });

  it('entered_overage は状態へ広げていない（意図した線）', () => {
    const d = decideTokenRotation(
      'free_exhausted',
      { facts: { kind: 'five_hour', usingOverage: true } },
      'current',
    );
    expect(d.rotate).toBe(false);
  });

  it('回さなかった回の signal は none のまま（毎ターン届く観測で日誌を埋めない）', () => {
    expect(decideTokenRotation('free_exhausted', restated, 'unknown').signal).toBe('none');
  });
});

describe('reached は off 以外のどちらの設定でも回る', () => {
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
    expect(cooldownUntilFrom({ resetsAt: 1_000, overageResetsAt: 9_000 })).toBe(1_000);
  });

  it('枠の resetsAt が無ければ課金枠のほうを採る', () => {
    expect(cooldownUntilFrom({ overageResetsAt: 9_000 })).toBe(9_000);
  });

  it('取れなければ undefined（既定を関数の中に持たない）', () => {
    expect(cooldownUntilFrom({ kind: 'five_hour', status: 'rejected' })).toBeUndefined();
    expect(cooldownUntilFrom(undefined)).toBeUndefined();
  });

  it('過去の値を未来へ丸めない', () => {
    expect(cooldownUntilFrom({ resetsAt: 1 })).toBe(1);
  });
});

describe('#680: 覚えている事実から期限を選ぶ', () => {
  const NOW = 1_000_000;

  it('いちばん早い期限を採る（遅いほうを採ると早く開く枠を待たずに寝る）', () => {
    const chosen = earliestRememberedCooldown(
      [
        { kind: 'seven_day', status: 'rejected', resetsAt: NOW + 90_000 },
        { kind: 'five_hour', status: 'rejected', resetsAt: NOW + 10_000 },
      ],
      NOW,
    );
    expect(chosen).toEqual({ at: NOW + 10_000, source: 'quota_reset' });
  });

  it('過ぎた期限は使わない（その窓はもう開いている）', () => {
    expect(
      earliestRememberedCooldown([{ kind: 'five_hour', status: 'rejected', resetsAt: NOW }], NOW),
    ).toBeUndefined();
    expect(
      earliestRememberedCooldown(
        [{ kind: 'five_hour', status: 'rejected', resetsAt: NOW - 1 }],
        NOW,
      ),
    ).toBeUndefined();
  });

  it('過ぎたものと先のものが混ざっていたら、先のものだけを見る', () => {
    const chosen = earliestRememberedCooldown(
      [
        { kind: 'five_hour', status: 'rejected', resetsAt: NOW - 5_000 },
        { kind: 'seven_day', status: 'rejected', resetsAt: NOW + 5_000 },
      ],
      NOW,
    );
    expect(chosen).toEqual({ at: NOW + 5_000, source: 'quota_reset' });
  });

  it('期限を運んでいない事実しか無ければ undefined（既定へ倒す side へ返す）', () => {
    expect(
      earliestRememberedCooldown([{ kind: 'five_hour', status: 'rejected' }], NOW),
    ).toBeUndefined();
    expect(earliestRememberedCooldown([], NOW)).toBeUndefined();
  });

  it('枠の resetsAt が無い事実では課金枠の側を使う（優先順は1箇所が持つ）', () => {
    expect(
      earliestRememberedCooldown(
        [{ kind: 'five_hour', status: 'rejected', overageResetsAt: NOW + 3_000 }],
        NOW,
      ),
    ).toEqual({ at: NOW + 3_000, source: 'overage_reset' });
  });
});

describe('observationFreshness', () => {
  const active: ActiveAgentToken = {
    tokenId: 'tok-a',
    generation: 3,
    rotatedAt: '2026-08-25T03:00:00.000Z',
  };

  it('現役と同じ身元なら current', () => {
    expect(observationFreshness(active, { tokenId: 'tok-a', generation: 3 })).toBe('current');
  });

  it('世代が違えば stale（もう回した後の通知）', () => {
    expect(observationFreshness(active, { tokenId: 'tok-a', generation: 2 })).toBe('stale');
  });

  it('id が違えば stale', () => {
    expect(observationFreshness(active, { tokenId: 'tok-b', generation: 3 })).toBe('stale');
  });

  it('id は同じで世代だけ古い形も捕まえる（冷却明けに同じ本が選ばれた後）', () => {
    expect(observationFreshness(active, { tokenId: 'tok-a', generation: 1 })).toBe('stale');
  });

  it('身元が何も付いていなければ unknown（current と答えない）', () => {
    expect(observationFreshness(active, {})).toBe('unknown');
  });

  it('現役がまだ無ければ unknown（照合する相手が居ない）', () => {
    expect(observationFreshness(null, { tokenId: 'tok-a', generation: 3 })).toBe('unknown');
    expect(observationFreshness(null, {})).toBe('unknown');
  });

  it('片方だけ付いていれば、その片方で照合する', () => {
    expect(observationFreshness(active, { tokenId: 'tok-a' })).toBe('current');
    expect(observationFreshness(active, { generation: 3 })).toBe('current');
    expect(observationFreshness(active, { tokenId: 'tok-b' })).toBe('stale');
    expect(observationFreshness(active, { generation: 9 })).toBe('stale');
  });
});

describe('selectNextToken', () => {
  const NOW = Date.parse('2026-08-25T03:00:00.000Z');
  const token = (over: Partial<AgentToken> & { id: string; order: number }): AgentToken => ({
    label: over.id,
    value: `value-of-${over.id}`,
    ...over,
  });

  it('order 昇順で最初の ready を選ぶ', () => {
    const sel = selectNextToken(
      [
        token({ id: 'tok-c', order: 2 }),
        token({ id: 'tok-a', order: 0 }),
        token({ id: 'tok-b', order: 1 }),
      ],
      { at: NOW },
    );
    expect(sel.kind).toBe('candidate');
    expect(sel.kind === 'candidate' && sel.token.id).toBe('tok-a');
  });

  it('外されている・失効している・冷却中は飛ばす', () => {
    const sel = selectNextToken(
      [
        token({ id: 'disabled', order: 0, disabledAt: '2026-08-01T00:00:00.000Z' }),
        token({ id: 'invalidated', order: 1, invalidatedAt: '2026-08-01T00:00:00.000Z' }),
        token({ id: 'cooling', order: 2, cooldownUntil: NOW + 60_000 }),
        token({ id: 'ready', order: 3 }),
      ],
      { at: NOW },
    );
    expect(sel.kind === 'candidate' && sel.token.id).toBe('ready');
  });

  it('降りた本人を候補から外す（自分自身へ「回す」を作らない）', () => {
    const outgoing = token({ id: 'tok-a', order: 0, cooldownUntil: NOW - 1 });
    const sel = selectNextToken([outgoing, token({ id: 'tok-b', order: 1 })], {
      at: NOW,
      exclude: 'tok-a',
    });
    expect(sel.kind === 'candidate' && sel.token.id).toBe('tok-b');
  });

  it('全部冷却中なら、いちばん早く戻るものとその時刻を出す（先頭へ戻らない）', () => {
    const sel = selectNextToken(
      [
        token({ id: 'late', order: 0, label: '遅いほう', cooldownUntil: NOW + 9_000 }),
        token({ id: 'soon', order: 1, label: '早いほう', cooldownUntil: NOW + 1_000 }),
      ],
      { at: NOW },
    );
    expect(sel.kind).toBe('none');
    expect(sel.kind === 'none' && sel.earliest).toEqual({
      tokenId: 'soon',
      label: '早いほう',
      cooldownUntil: NOW + 1_000,
    });
    expect(JSON.stringify(sel)).not.toContain('value-of-soon');
  });

  it('プールが空・降りた1本しか無い・全部外されている、を同じ出口へ倒す', () => {
    const empty = selectNextToken([], { at: NOW });
    const onlyOutgoing = selectNextToken([token({ id: 'tok-a', order: 0 })], {
      at: NOW,
      exclude: 'tok-a',
    });
    const allDisabled = selectNextToken(
      [token({ id: 'tok-a', order: 0, disabledAt: '2026-08-01T00:00:00.000Z' })],
      { at: NOW },
    );
    for (const sel of [empty, onlyOutgoing, allDisabled]) {
      expect(sel.kind).toBe('none');
      expect(sel.kind === 'none' && sel.earliest).toBeUndefined();
    }
  });

  it('冷却中のものが1本でもあれば、待てば戻ることが出口から読める', () => {
    const allDisabledButOneCooling = selectNextToken(
      [
        token({ id: 'off', order: 0, disabledAt: '2026-08-01T00:00:00.000Z' }),
        token({ id: 'cooling', order: 1, cooldownUntil: NOW + 5 }),
      ],
      { at: NOW },
    );
    expect(
      allDisabledButOneCooling.kind === 'none' && allDisabledButOneCooling.earliest?.tokenId,
    ).toBe('cooling');
  });

  it('冷却の期限が過ぎていれば ready として選ぶ（もう戻っている）', () => {
    const sel = selectNextToken([token({ id: 'tok-a', order: 0, cooldownUntil: NOW - 1 })], {
      at: NOW,
    });
    expect(sel.kind === 'candidate' && sel.token.id).toBe('tok-a');
  });
});
