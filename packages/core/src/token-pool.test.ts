import { describe, expect, it } from 'vitest';

import {
  agentTokenInputSchema,
  DEFAULT_TOKEN_ROTATION_POLICY,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  markTokenUnusable,
  markTokenUsable,
  normalizeTokenPool,
  toAgentTokenView,
  tokenAvailabilityAt,
  tokenRecoveryOf,
  type AgentToken,
} from './token-pool.js';

/**
 * 認証トークンのプールの器（Issue #393「PR1」）。
 *
 * **回さない。** ここで固定するのは器の形（正規化の規則・値が漏れないこと・
 * 既定の設定）だけであり、検知・切替（PR2 以降）はここには無い。
 */

describe('回す契機の既定', () => {
  it('既定は free_exhausted（受け入れ基準）', () => {
    expect(DEFAULT_TOKEN_ROTATION_POLICY).toBe('free_exhausted');
    expect(DEFAULT_TOKEN_ROTATION_SETTINGS.rotateOn).toBe('free_exhausted');
  });
});

function opts(ids: string[] = ['tok-new']) {
  const queue = [...ids];
  return {
    now: () => new Date('2026-08-24T00:00:00.000Z'),
    newId: () => queue.shift() ?? 'tok-fallback',
  };
}

describe('normalizeTokenPool', () => {
  it('id が既存に在れば value / cooldownUntil / lastRejectedAt / lastRejectedReason / invalidatedAt / invalidatedReason を引き継ぐ', () => {
    const existing: AgentToken[] = [
      {
        id: 'tok-a',
        label: 'old-label',
        value: 'tok-aaa',
        order: 0,
        cooldownUntil: 12345,
        lastRejectedAt: '2026-08-01T00:00:00.000Z',
        lastRejectedReason: 'rate_limit',
        invalidatedAt: '2026-08-02T00:00:00.000Z',
        invalidatedReason: 'disabled_by_org',
      },
    ];

    const result = normalizeTokenPool([{ id: 'tok-a', label: 'renamed' }], existing, opts());

    expect(result).toEqual([
      {
        id: 'tok-a',
        label: 'renamed',
        value: 'tok-aaa',
        order: 0,
        cooldownUntil: 12345,
        lastRejectedAt: '2026-08-01T00:00:00.000Z',
        lastRejectedReason: 'rate_limit',
        invalidatedAt: '2026-08-02T00:00:00.000Z',
        invalidatedReason: 'disabled_by_org',
        // **後から足した列**（Issue #393）。`label` が変わっているので判が押される。
        // 期待値をここへ書き足しているのは、`toEqual` を緩めずに済ませるため
        // ——`toMatchObject` へ替えると「他に何も付いていない」という保証が消え、
        // 値（`value`）が思わぬ形で増えたときにも通ってしまう。
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
    ]);
  });

  it('入力に value が在れば、引き継がずそちらで上書きする', () => {
    const existing: AgentToken[] = [{ id: 'tok-a', label: 'old', value: 'tok-aaa', order: 0 }];
    const result = normalizeTokenPool(
      [{ id: 'tok-a', label: 'old', value: 'tok-bbb' }],
      existing,
      opts(),
    );
    expect(result[0]?.value).toBe('tok-bbb');
  });

  it('新規行（id 省略）に value も無ければ Error を投げる', () => {
    expect(() => normalizeTokenPool([{ label: '新規' }], [], opts())).toThrow();
  });

  it('id が指定されているのに既存に無ければ Error を投げる（消えた行を静かに作り直さない）', () => {
    expect(() =>
      normalizeTokenPool([{ id: 'ghost', label: '幽霊', value: 'tok-x' }], [], opts()),
    ).toThrow();
  });

  it('入力の中で id が重複していたら Error を投げる', () => {
    const existing: AgentToken[] = [{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }];
    expect(() =>
      normalizeTokenPool(
        [
          { id: 'tok-a', label: 'a1' },
          { id: 'tok-a', label: 'a2' },
        ],
        existing,
        opts(),
      ),
    ).toThrow();
  });

  it('order は明示があればそれ、無ければ配列内の位置。明示すれば配列の位置を上書きできる', () => {
    const result = normalizeTokenPool(
      [
        { label: 'first-by-position', value: 'tok-1' },
        // 配列内では2番目だが、明示 order で最後尾へ回す。
        { label: 'explicit-last', value: 'tok-2', order: 100 },
        { label: 'second-by-position', value: 'tok-3' },
      ],
      [],
      opts(['id-1', 'id-2', 'id-3']),
    );
    // 無指定の2本は配列内の位置（0, 2）どおりの順で残り、明示 order=100 の
    // ものだけがそれを上書きして最後尾へ回る。
    expect(result.map((t) => t.label)).toEqual([
      'first-by-position',
      'second-by-position',
      'explicit-last',
    ]);
  });

  it('order が同値なら入力順で安定する', () => {
    const result = normalizeTokenPool(
      [
        { label: 'first', value: 'tok-1', order: 5 },
        { label: 'second', value: 'tok-2', order: 5 },
        { label: 'third', value: 'tok-3', order: 5 },
      ],
      [],
      opts(['id-1', 'id-2', 'id-3']),
    );
    expect(result.map((t) => t.label)).toEqual(['first', 'second', 'third']);
  });

  describe('disabled の3状態', () => {
    it('true → disabledAt は既存が在ればそのまま', () => {
      const existing: AgentToken[] = [
        {
          id: 'tok-a',
          label: 'a',
          value: 'tok-aaa',
          order: 0,
          disabledAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      const result = normalizeTokenPool(
        [{ id: 'tok-a', label: 'a', disabled: true }],
        existing,
        opts(),
      );
      expect(result[0]?.disabledAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('true → disabledAt が無ければ now() を立てる', () => {
      const existing: AgentToken[] = [{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }];
      const result = normalizeTokenPool(
        [{ id: 'tok-a', label: 'a', disabled: true }],
        existing,
        opts(),
      );
      expect(result[0]?.disabledAt).toBe('2026-08-24T00:00:00.000Z');
    });

    it('false → disabledAt を落とす', () => {
      const existing: AgentToken[] = [
        {
          id: 'tok-a',
          label: 'a',
          value: 'tok-aaa',
          order: 0,
          disabledAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      const result = normalizeTokenPool(
        [{ id: 'tok-a', label: 'a', disabled: false }],
        existing,
        opts(),
      );
      expect(result[0]?.disabledAt).toBeUndefined();
    });

    it('省略 → 既存のまま変えない', () => {
      const existing: AgentToken[] = [
        {
          id: 'tok-a',
          label: 'a',
          value: 'tok-aaa',
          order: 0,
          disabledAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      const result = normalizeTokenPool([{ id: 'tok-a', label: 'a' }], existing, opts());
      expect(result[0]?.disabledAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  it('入力に現れなかった既存の行は消える（全文置換）', () => {
    const existing: AgentToken[] = [
      { id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 },
      { id: 'tok-b', label: 'b', value: 'tok-bbb', order: 1 },
    ];
    const result = normalizeTokenPool([{ id: 'tok-a', label: 'a' }], existing, opts());
    expect(result.map((t) => t.id)).toEqual(['tok-a']);
  });

  it('agentTokenInputSchema には invalidatedAt / invalidatedReason を渡す口が無い（人間は disabled でしか外せない）', () => {
    // `agentTokenInputSchema` の型（`AgentTokenInput`）にそもそも無いフィールド
    // なので、`unknown` を経由して渡す（実行時に無視される／弾かれることを見る）。
    const raw: unknown = {
      label: 'x',
      value: 'tok-aaa',
      invalidatedAt: '2026-01-01T00:00:00.000Z',
      invalidatedReason: 'disabled_by_org',
    };
    const parsed = agentTokenInputSchema.parse(raw);
    expect(parsed).not.toHaveProperty('invalidatedAt');
    expect(parsed).not.toHaveProperty('invalidatedReason');
  });

  it('PUT の往復（normalizeTokenPool を2回通す）でも invalidatedAt / invalidatedReason を落とさない', () => {
    const afterFirstRotationDecision: AgentToken[] = [
      {
        id: 'tok-a',
        label: 'a',
        value: 'tok-aaa',
        order: 0,
        invalidatedAt: '2026-08-02T00:00:00.000Z',
        invalidatedReason: 'account_on_hold',
      },
    ];
    // 人間が並べ替え・改名のためにもう一度 PUT /tokens を打つ（value は省略）。
    const result = normalizeTokenPool(
      [{ id: 'tok-a', label: 'a-renamed', order: 3 }],
      afterFirstRotationDecision,
      opts(),
    );
    expect(result[0]).toMatchObject({
      invalidatedAt: '2026-08-02T00:00:00.000Z',
      invalidatedReason: 'account_on_hold',
    });
  });
});

describe('toAgentTokenView', () => {
  const SECRET = 'tok-aaa-super-secret-value';

  it('値が1文字も含まれない', () => {
    const token: AgentToken = {
      id: 'tok-a',
      label: 'a',
      value: SECRET,
      order: 0,
      lastRejectedReason: 'rate_limit exceeded, please slow down',
      invalidatedReason: 'account_on_hold',
    };
    const serialized = JSON.stringify(toAgentTokenView(token));
    expect(serialized).not.toContain(SECRET);
  });

  it('invalidatedAt / invalidatedReason は出す（値ではないので秘密ではない）', () => {
    const token: AgentToken = {
      id: 'tok-a',
      label: 'a',
      value: SECRET,
      order: 0,
      invalidatedAt: '2026-08-02T00:00:00.000Z',
      invalidatedReason: 'account_on_hold',
    };
    const view = toAgentTokenView(token);
    expect(view.invalidatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(view.invalidatedReason).toBe('account_on_hold');
    expect(view).not.toHaveProperty('value');
  });

  it('sha256 は fingerprintOf と同じ指紋を持つ（値の同一性は見える）', () => {
    const token: AgentToken = { id: 'tok-a', label: 'a', value: SECRET, order: 0 };
    const view = toAgentTokenView(token);
    expect(view.sha256).toHaveLength(12);
    expect(view.sha256).toMatch(/^[0-9a-f]{12}$/);
  });
});

/**
 * 置いた時刻 / 変わった時刻（Issue #393）。**判を押すのは変わった行だけ**という
 * ことが、この列の意味そのものである（`AgentToken.updatedAt` の doc）。
 */
describe('createdAt / updatedAt', () => {
  const NOW = '2026-08-24T00:00:00.000Z';

  it('新規行には createdAt と updatedAt の両方が立つ', () => {
    const [token] = normalizeTokenPool([{ label: 'a', value: 'v' }], [], opts(['tok-a']));
    expect(token?.createdAt).toBe(NOW);
    expect(token?.updatedAt).toBe(NOW);
  });

  it('既存の行を変えなければ updatedAt は動かない（全文置換でも判を押さない）', () => {
    // **これがこの列の存在理由である。** 全行に押すと「最後に誰かが PUT を
    // 打った時刻」に化けて、どの行がいつ変わったかが取れなくなる。
    const existing: AgentToken[] = [
      {
        id: 'tok-a',
        label: 'a',
        value: 'v',
        order: 0,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      { id: 'tok-b', label: 'b', value: 'w', order: 1 },
    ];
    // b の label だけ変える。a は素通り。
    const result = normalizeTokenPool(
      [
        { id: 'tok-a', label: 'a' },
        { id: 'tok-b', label: 'b-renamed' },
      ],
      existing,
      opts(),
    );
    expect(result[0]?.updatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(result[1]?.updatedAt).toBe(NOW);
  });

  it('createdAt は既存の行では引き継ぐ（無い行を now() で埋め直さない）', () => {
    // PR1 の版が書いた行には createdAt が無い。**「いま作られた」と書かない。**
    const existing: AgentToken[] = [{ id: 'tok-a', label: 'a', value: 'v', order: 0 }];
    const [token] = normalizeTokenPool([{ id: 'tok-a', label: 'renamed' }], existing, opts());
    expect(token).not.toHaveProperty('createdAt');
    // 変わったので updatedAt のほうは立つ。
    expect(token?.updatedAt).toBe(NOW);
  });

  it('value / order / disabled の変更も「変わった」として数える', () => {
    const base: AgentToken = { id: 'tok-a', label: 'a', value: 'v', order: 0 };
    const changedValue = normalizeTokenPool(
      [{ id: 'tok-a', label: 'a', value: 'v2' }],
      [base],
      opts(),
    );
    expect(changedValue[0]?.updatedAt).toBe(NOW);
    const changedOrder = normalizeTokenPool(
      [{ id: 'tok-a', label: 'a', order: 5 }],
      [base],
      opts(),
    );
    expect(changedOrder[0]?.updatedAt).toBe(NOW);
    const disabled = normalizeTokenPool(
      [{ id: 'tok-a', label: 'a', disabled: true }],
      [base],
      opts(),
    );
    expect(disabled[0]?.updatedAt).toBe(NOW);
    // 何も変えなければ立たない（そもそも前も無かったので、無いまま）。
    const untouched = normalizeTokenPool([{ id: 'tok-a', label: 'a' }], [base], opts());
    expect(untouched[0]).not.toHaveProperty('updatedAt');
  });
});

/**
 * 止まった事実の記録と、その取り消し（Issue #393）。
 *
 * **回さない。** ここが固定するのは「1行に何を書くか / 何を書かないか」だけで、
 * 次の候補を選ぶ側（PR3）はここに無い。
 */
describe('markTokenUnusable / markTokenUsable', () => {
  const AT = '2026-08-25T03:00:00.000Z';
  const FALLBACK = 5 * 60 * 60 * 1000;
  const base: AgentToken = { id: 'tok-a', label: 'a', value: 'secret-value', order: 0 };
  const MESSAGE = "You've hit your org's monthly spend limit";

  it('いつ・何と言われたか・いつ戻る見込みかの3つを書く', () => {
    const marked = markTokenUnusable(base, {
      at: AT,
      message: MESSAGE,
      resetsAt: 1_800_000_000_000,
      fallbackCooldownMs: FALLBACK,
    });
    expect(marked.lastRejectedAt).toBe(AT);
    expect(marked.lastRejectedReason).toBe(MESSAGE);
    expect(marked.cooldownUntil).toBe(1_800_000_000_000);
    expect(marked.updatedAt).toBe(AT);
  });

  it('文言をそのまま持つ（言い換えると分類が unknown へ落ちる）', () => {
    const marked = markTokenUnusable(base, {
      at: AT,
      message: MESSAGE,
      fallbackCooldownMs: FALLBACK,
    });
    // 生の文言が残っているので、分類がそこから導ける。
    expect(tokenRecoveryOf(marked)).toBe('time');
    // 言い換えた（＝接頭辞を壊した）形では導けなくなることを、同じ歯で示す。
    const paraphrased = markTokenUnusable(base, {
      at: AT,
      message: '月間の支出上限に達しました',
      fallbackCooldownMs: FALLBACK,
    });
    expect(tokenRecoveryOf(paraphrased)).toBe('unknown');
  });

  it('resetsAt が取れなければ、渡された既定で冷やす（関数の中に既定を持たない）', () => {
    const marked = markTokenUnusable(base, {
      at: AT,
      message: MESSAGE,
      fallbackCooldownMs: FALLBACK,
    });
    expect(marked.cooldownUntil).toBe(Date.parse(AT) + FALLBACK);
  });

  it('resetsAt が過去でも未来へ丸めない（「もう戻っている」を正しく表す）', () => {
    const past = Date.parse('2026-08-01T00:00:00.000Z');
    const marked = markTokenUnusable(base, {
      at: AT,
      message: MESSAGE,
      resetsAt: past,
      fallbackCooldownMs: FALLBACK,
    });
    expect(marked.cooldownUntil).toBe(past);
    expect(tokenAvailabilityAt(marked, Date.parse(AT))).toBe('ready');
  });

  it('人間が外した印（disabledAt）と失効の印は観測で上書きしない', () => {
    const human: AgentToken = {
      ...base,
      disabledAt: '2026-08-10T00:00:00.000Z',
      invalidatedAt: '2026-08-11T00:00:00.000Z',
      invalidatedReason: 'account_on_hold',
    };
    const marked = markTokenUnusable(human, {
      at: AT,
      message: MESSAGE,
      fallbackCooldownMs: FALLBACK,
    });
    expect(marked.disabledAt).toBe('2026-08-10T00:00:00.000Z');
    expect(marked.invalidatedAt).toBe('2026-08-11T00:00:00.000Z');
    expect(marked.invalidatedReason).toBe('account_on_hold');
  });

  it('action と判定される文言でも冷却へ倒す（当面は一律。分類は記録するだけ）', () => {
    // **人間の決定（2026-08-25）**: 種類で分けるのは記録までにして、扱いは
    // 一律で「時間で戻る」と仮定する。⟹ `invalidatedAt` はここでは立たない。
    const marked = markTokenUnusable(base, {
      at: AT,
      message: 'Your usage allocation has been disabled by your admin',
      fallbackCooldownMs: FALLBACK,
    });
    expect(tokenRecoveryOf(marked)).toBe('action');
    expect(marked).not.toHaveProperty('invalidatedAt');
    expect(marked.cooldownUntil).toBe(Date.parse(AT) + FALLBACK);
    expect(tokenAvailabilityAt(marked, Date.parse(AT))).toBe('cooling');
  });

  it('使えることを確かめられたら、止まっていた記録を消す（人間の印は残す）', () => {
    const stuck: AgentToken = {
      ...base,
      disabledAt: '2026-08-10T00:00:00.000Z',
      cooldownUntil: 1_800_000_000_000,
      lastRejectedAt: AT,
      lastRejectedReason: MESSAGE,
      invalidatedAt: '2026-08-11T00:00:00.000Z',
      invalidatedReason: 'account_on_hold',
    };
    const cleared = markTokenUsable(stuck, '2026-08-25T09:00:00.000Z');
    expect(cleared).not.toHaveProperty('cooldownUntil');
    expect(cleared).not.toHaveProperty('lastRejectedAt');
    expect(cleared).not.toHaveProperty('lastRejectedReason');
    // 通ったのに「恒常的に通らない」印が残るのは、それ自体が嘘である。
    expect(cleared).not.toHaveProperty('invalidatedAt');
    expect(cleared).not.toHaveProperty('invalidatedReason');
    // 人間が外した印は消さない。
    expect(cleared.disabledAt).toBe('2026-08-10T00:00:00.000Z');
    expect(cleared.updatedAt).toBe('2026-08-25T09:00:00.000Z');
    // 値は保つ（記録の消去は資格の消去ではない）。
    expect(cleared.value).toBe('secret-value');
  });
});

describe('tokenAvailabilityAt', () => {
  const base: AgentToken = { id: 'tok-a', label: 'a', value: 'v', order: 0 };
  const NOW = Date.parse('2026-08-25T03:00:00.000Z');

  it('何も無ければ ready', () => {
    expect(tokenAvailabilityAt(base, NOW)).toBe('ready');
  });

  it('冷却の期限が未来なら cooling、過ぎていれば ready', () => {
    expect(tokenAvailabilityAt({ ...base, cooldownUntil: NOW + 1 }, NOW)).toBe('cooling');
    expect(tokenAvailabilityAt({ ...base, cooldownUntil: NOW }, NOW)).toBe('ready');
    expect(tokenAvailabilityAt({ ...base, cooldownUntil: NOW - 1 }, NOW)).toBe('ready');
  });

  it('人間が外した印がいちばん強い（冷却中でも disabled と答える）', () => {
    const both = { ...base, disabledAt: '2026-08-10T00:00:00.000Z', cooldownUntil: NOW + 1 };
    expect(tokenAvailabilityAt(both, NOW)).toBe('disabled');
  });

  it('失効は冷却より強い（待てば戻ると読ませない）', () => {
    const both = { ...base, invalidatedAt: '2026-08-11T00:00:00.000Z', cooldownUntil: NOW + 1 };
    expect(tokenAvailabilityAt(both, NOW)).toBe('invalidated');
  });
});

describe('外向きの顔に載る回復の見込み', () => {
  const SECRET_VALUE = 'sk-do-not-leak';

  it('拒否の記録が無ければ recovery も無い（unknown へ潰さない）', () => {
    const view = toAgentTokenView({ id: 'tok-a', label: 'a', value: SECRET_VALUE, order: 0 });
    expect(view).not.toHaveProperty('recovery');
  });

  it('生の文言から毎回導く（保存しない）', () => {
    const view = toAgentTokenView({
      id: 'tok-a',
      label: 'a',
      value: SECRET_VALUE,
      order: 0,
      lastRejectedReason: "You've hit your org's monthly spend limit",
    });
    expect(view.recovery).toBe('time');
  });

  it('createdAt / updatedAt は出す（秘密ではない）が、値は出さない', () => {
    const view = toAgentTokenView({
      id: 'tok-a',
      label: 'a',
      value: SECRET_VALUE,
      order: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      lastRejectedReason: 'Your org is out of usage · contact your admin',
    });
    expect(view.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(view.updatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(view.recovery).toBe('action');
    expect(JSON.stringify(view)).not.toContain(SECRET_VALUE);
  });
});
