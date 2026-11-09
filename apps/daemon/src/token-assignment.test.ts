import type { AccountUsageState, AgentToken } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { CLONE_ASSIGNMENT_UNIT, createTokenAssignmentBook } from './token-assignment.js';

const AT = Date.parse('2026-11-09T10:00:00Z');

function token(id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken {
  return { id, label: `label-${id}`, value: `tok-fake-${id}`, order, ...extra };
}

function usage(utilization: number): AccountUsageState {
  return {
    state: 'ok',
    usage: {
      at: '2026-11-09T10:00:00Z',
      limitsAvailable: true,
      windows: [{ kind: 'five_hour', utilization }],
    },
  } as AccountUsageState;
}

function book(
  tokens: AgentToken[],
  options: { balanced?: boolean; loads?: Record<string, number>; now?: () => number } = {},
) {
  const state = { balanced: options.balanced ?? true, tokens, now: options.now ?? (() => AT) };
  const loads = Object.entries(options.loads ?? {}).map(([tokenId, u]) => ({
    tokenId,
    state: usage(u),
  }));
  const b = createTokenAssignmentBook({
    readTokens: async () => state.tokens,
    balanced: async () => state.balanced,
    loads: () => loads,
    now: () => state.now(),
  });
  return { b, state };
}

describe('割り当ての帳面（#6633）', () => {
  it('failover の間は割り当てない（従来どおり器の現役で走る）', async () => {
    const { b } = book([token('a', 0)], { balanced: false });
    expect(await b.assign('mgr-1')).toBeUndefined();
    expect(b.target('mgr-1')).toBeUndefined();
  });

  it('いちばん空いている鍵を割り当て、値は帳面から読める', async () => {
    const { b } = book([token('a', 0), token('b', 1)], { loads: { a: 80, b: 10 } });
    const assigned = await b.assign('mgr-1');
    expect(assigned?.tokenId).toBe('b');
    expect(b.valueOf('mgr-1')).toBe('tok-fake-b');
  });

  it('混み具合が分からなければ、割り当て中の数で散らす（クローンも1つの作業単位に数える）', async () => {
    const { b } = book([token('a', 0), token('b', 1)]);
    const clone = await b.assign(CLONE_ASSIGNMENT_UNIT);
    const first = await b.assign('mgr-1');
    const second = await b.assign('mgr-2');
    expect(clone?.tokenId).toBe('a');
    expect(first?.tokenId).toBe('b');
    expect([clone?.tokenId, first?.tokenId, second?.tokenId].sort()).toEqual(['a', 'a', 'b']);
  });

  it('通る鍵が1本だけなら、全員がその鍵を使う（作業を止めない）', async () => {
    const { b } = book([token('a', 0), token('b', 1, { cooldownUntil: AT + 60_000 })]);
    expect((await b.assign(CLONE_ASSIGNMENT_UNIT))?.tokenId).toBe('a');
    expect((await b.assign('mgr-1'))?.tokenId).toBe('a');
    expect((await b.assign('mgr-2'))?.tokenId).toBe('a');
  });

  it('resume では前の鍵が通るかぎり替えず、身元（世代）も替えない', async () => {
    const { b } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 90 } });
    const first = await b.assign('mgr-1');
    const again = await b.assign('mgr-1', { prior: 'a' });
    expect(again).toEqual(first);
  });

  it('job に残った前の鍵（引き取り後で帳面が空）でも、通るならその鍵へ戻す', async () => {
    const { b } = book([token('a', 0), token('b', 1)], { loads: { a: 90, b: 10 } });
    expect((await b.assign('mgr-1', { prior: 'a' }))?.tokenId).toBe('a');
  });

  it('前の鍵が冷却中なら、通る鍵へ移る', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 90 } });
    expect((await b.assign('mgr-1'))?.tokenId).toBe('a');
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1)];
    expect((await b.assign('mgr-1', { prior: 'a' }))?.tokenId).toBe('b');
  });

  it('evacuate は止まった鍵の持ち主だけを移し、他の鍵の持ち主は動かさない', async () => {
    const { b, state } = book([token('a', 0), token('b', 1), token('c', 2)], {
      loads: { a: 10, b: 20, c: 30 },
    });
    await b.assign('mgr-on-a');
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1), token('c', 2)];
    await b.assign('mgr-on-b');
    const before = b.target('mgr-on-b');

    const result = await b.evacuate('a');

    expect(result.moved.map((move) => [move.unitId, move.from.tokenId, move.to.tokenId])).toEqual([
      ['mgr-on-a', 'a', 'b'],
    ]);
    expect(b.target('mgr-on-b')).toEqual(before);
    expect(result.stranded).toEqual([]);
  });

  it('通る鍵が1本も無ければ、移せなかった持ち主として返し、割り当てを外す', async () => {
    const { b, state } = book([token('a', 0)]);
    await b.assign(CLONE_ASSIGNMENT_UNIT);
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 })];
    const result = await b.evacuate('a');
    expect(result).toEqual({ moved: [], stranded: [CLONE_ASSIGNMENT_UNIT] });
    expect(b.target(CLONE_ASSIGNMENT_UNIT)).toBeUndefined();
  });

  it('reconcile は割り当てた鍵が通らなくなった持ち主を、通る鍵へ移し直す', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 90 } });
    await b.assign('mgr-1');
    state.tokens = [token('a', 0, { disabledAt: '2026-11-09T10:00:00Z' }), token('b', 1)];
    const result = await b.reconcile();
    expect(result.moved.map((move) => move.to.tokenId)).toEqual(['b']);
  });

  it('値を差し替えた鍵は、同じ id でも持ち主を新しい値で割り当て直す', async () => {
    const { b, state } = book([token('a', 0)]);
    const first = await b.assign('mgr-1');
    state.tokens = [{ ...token('a', 0), value: 'tok-fake-a-rotated' }];
    await b.reconcile();
    const again = await b.assign('mgr-1', { prior: 'a' });
    expect(again?.value).toBe('tok-fake-a-rotated');
    expect(again?.generation).not.toBe(first?.generation);
  });

  it('知らせの身元: いまの割り当ては current、前の割り当ては stale、帳面が出していない世代は unknown', async () => {
    let clock = AT;
    const { b, state } = book([token('a', 0), token('b', 1)], {
      loads: { a: 10, b: 90 },
      now: () => clock,
    });
    const first = await b.assign('mgr-1');
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1)];
    clock += 1;
    const moved = await b.assign('mgr-1', { prior: 'a' });

    expect(first && b.freshnessOf(first)).toBe('stale');
    expect(moved && b.freshnessOf(moved)).toBe('current');
    expect(b.freshnessOf({ tokenId: 'a', generation: 3 })).toBe('unknown');
  });

  it('配り方を failover へ戻したら、次の assign で割り当てを外す', async () => {
    const { b, state } = book([token('a', 0)]);
    await b.assign('mgr-1');
    state.balanced = false;
    expect(await b.assign('mgr-1', { prior: 'a' })).toBeUndefined();
    expect(b.target('mgr-1')).toBeUndefined();
  });
});
