import { describe, expect, it } from 'vitest';

import { selectBalancedToken, tokenLoadScoreOf } from './token-balance.js';
import type { AgentToken } from './token-pool.js';
import type { AccountUsageState } from './usage-snapshot.js';

const AT = Date.parse('2026-11-09T10:00:00Z');

function token(id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken {
  return { id, label: id, value: `tok-fake-${id}`, order, ...extra };
}

function pick(
  tokens: AgentToken[],
  scores: Record<string, number | undefined> = {},
  counts: Record<string, number> = {},
  exclude?: string[],
): string | undefined {
  const selection = selectBalancedToken({
    tokens,
    at: AT,
    loadScores: new Map(Object.entries(scores)),
    assignedCounts: new Map(Object.entries(counts)),
    ...(exclude === undefined ? {} : { exclude }),
  });
  return selection.kind === 'candidate' ? selection.token.id : undefined;
}

describe('selectBalancedToken（#6633）', () => {
  it('いちばん空いている鍵を選ぶ（試す順より混み具合が先）', () => {
    expect(pick([token('a', 0), token('b', 1), token('c', 2)], { a: 70, b: 20, c: 40 })).toBe('b');
  });

  it('冷却中・外した・失効した鍵は、空いていても選ばない', () => {
    const tokens = [
      token('cool', 0, { cooldownUntil: AT + 60_000 }),
      token('off', 1, { disabledAt: '2026-11-09T00:00:00Z' }),
      token('dead', 2, { invalidatedAt: '2026-11-09T00:00:00Z' }),
      token('busy', 3),
    ];
    expect(pick(tokens, { cool: 0, off: 0, dead: 0, busy: 90 })).toBe('busy');
  });

  it('通る鍵が1本だけなら、混んでいても割り当て中でもそれを選ぶ（作業を止めない）', () => {
    expect(
      pick(
        [token('only', 0), token('cool', 1, { cooldownUntil: AT + 1 })],
        { only: 95 },
        { only: 5 },
      ),
    ).toBe('only');
  });

  it('混み具合が同じなら、割り当て中のセッションが少ない鍵を選ぶ', () => {
    expect(pick([token('a', 0), token('b', 1)], { a: 30, b: 30 }, { a: 3, b: 1 })).toBe('b');
  });

  it('どれも測れていなければ、割り当ての数で振り分ける', () => {
    expect(pick([token('a', 0), token('b', 1), token('c', 2)], {}, { a: 2, b: 0, c: 1 })).toBe('b');
  });

  it('測っていない鍵は、測れた鍵の平均として扱う（最も空いている扱いにも、最も混んでいる扱いにもしない）', () => {
    const tokens = [token('low', 0), token('high', 1), token('new', 2)];
    // 平均は 50。新しい鍵（50 扱い）は 20 より後、80 より先
    expect(pick(tokens, { low: 20, high: 80 })).toBe('low');
    expect(pick(tokens, { low: 20, high: 80 }, {}, ['low'])).toBe('new');
  });

  it('通る鍵が1本も無ければ none を返し、いちばん早く戻る鍵の見込みを付ける', () => {
    const selection = selectBalancedToken({
      tokens: [
        token('late', 0, { cooldownUntil: AT + 120_000 }),
        token('soon', 1, { cooldownUntil: AT + 60_000 }),
      ],
      at: AT,
      loadScores: new Map(),
      assignedCounts: new Map(),
    });
    expect(selection.kind).toBe('none');
    expect(selection.kind === 'none' ? selection.earliest?.tokenId : undefined).toBe('soon');
  });
});

describe('tokenLoadScoreOf（#6633）', () => {
  const ok = (windows: { kind: string; utilization?: number }[]): AccountUsageState =>
    ({
      state: 'ok',
      usage: { at: '2026-11-09T10:00:00Z', limitsAvailable: true, windows },
    }) as AccountUsageState;

  it('窓の使用率の最大を採る（週が尽きかけの鍵を空いていると読まない）', () => {
    expect(
      tokenLoadScoreOf(
        ok([
          { kind: 'five_hour', utilization: 10 },
          { kind: 'seven_day', utilization: 92 },
        ]),
      ),
    ).toBe(92);
  });

  it('使用率が無い・測れなかった・まだ測っていないは undefined（0 にしない）', () => {
    expect(tokenLoadScoreOf(ok([]))).toBeUndefined();
    expect(tokenLoadScoreOf({ state: 'failed', at: '2026-11-09T10:00:00Z', reason: 'r' })).toBe(
      undefined,
    );
    expect(tokenLoadScoreOf({ state: 'unknown' })).toBeUndefined();
    expect(tokenLoadScoreOf(undefined)).toBeUndefined();
  });
});
