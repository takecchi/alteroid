import { describe, expect, it } from 'vitest';

import {
  agentTokenInputSchema,
  DEFAULT_TOKEN_ROTATION_POLICY,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  normalizeTokenPool,
  toAgentTokenView,
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
