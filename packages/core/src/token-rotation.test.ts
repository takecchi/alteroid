import { describe, expect, it } from 'vitest';

import {
  cooldownUntilFrom,
  decideTokenRotation,
  observationFreshness,
  selectNextToken,
} from './token-rotation.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';
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

/**
 * 遅れて届いた通知を捨てる（世代の照合）。**受け入れ基準**: 同じ枠の当たりが
 * 複数のマネージャーから同時に届いても、回るのは1回だけ。
 */
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
    // **これが無いと、5本のマネージャーが同時に当たった回にプールを5個消費する。**
    expect(observationFreshness(active, { tokenId: 'tok-a', generation: 2 })).toBe('stale');
  });

  it('id が違えば stale', () => {
    expect(observationFreshness(active, { tokenId: 'tok-b', generation: 3 })).toBe('stale');
  });

  it('id は同じで世代だけ古い形も捕まえる（冷却明けに同じ本が選ばれた後）', () => {
    // id だけで照合すると、ここが current になって「もう回した後の通知」で
    // もう一度回る。
    expect(observationFreshness(active, { tokenId: 'tok-a', generation: 1 })).toBe('stale');
  });

  it('身元が何も付いていなければ unknown（current と答えない）', () => {
    // **2値にしない。** stale へ倒すと本物の当たりを飲み込み、しかもそれは
    // 何も起きないので見えない。current へ倒すと「照合した」という嘘になる。
    expect(observationFreshness(active, {})).toBe('unknown');
  });

  it('現役がまだ無ければ unknown（照合する相手が居ない）', () => {
    // 器の環境変数だけで走っている状態。current と答えると嘘になる。
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
    // **resetsAt が既に過ぎている値で来ることがある**（過去の値を未来へ丸めない）。
    // 過ぎていれば ready なので、外さないと降りた本人が最初の候補になり、
    // **日誌には「回した」と残るのに撒いた先は1文字も変わらない。**
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
    // 値は出さない。
    expect(JSON.stringify(sel)).not.toContain('value-of-soon');
  });

  it('プールが空・降りた1本しか無い・全部外されている、を同じ出口へ倒す', () => {
    // **3つを別々の分岐にしない**（Issue #393）。別にすると、呼ぶ側が3回同じ
    // 「先頭へ戻らずに待つ」を書くことになり、1つ忘れた分岐だけが黙って戻る。
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
      // **戻る時刻を 0 や now で埋めない**（「すぐ戻る」と読める）。
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
