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
  // 枠の観測は state から毎回読む: 試験の途中で混み具合を動かすため（#6642）
  const state = {
    balanced: options.balanced ?? true,
    tokens,
    now: options.now ?? (() => AT),
    loads: options.loads ?? ({} as Record<string, number>),
  };
  const loads = () =>
    Object.entries(state.loads).map(([tokenId, u]) => ({ tokenId, state: usage(u) }));
  const b = createTokenAssignmentBook({
    readTokens: async () => state.tokens,
    balanced: async () => state.balanced,
    loads,
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

describe('同じコンテナには同じ鍵を割り当て続ける（#6642）', () => {
  it('同じ runner の新しい委譲は、別の鍵が空いていてもコンテナの鍵へ寄せる（閾値未満のあいだ）', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 50 } });
    expect((await b.assign('mgr-1', { container: 'runner-1' }))?.tokenId).toBe('a');
    // a のほうが混んでも、閾値（90%）未満なら寄せ続ける
    state.loads = { a: 89, b: 5 };
    expect((await b.assign('mgr-2', { container: 'runner-1' }))?.tokenId).toBe('a');
    expect((await b.assign('mgr-3', { container: 'runner-1' }))?.tokenId).toBe('a');
  });

  it('対照: コンテナを渡さなければ、今までどおり空いている鍵へ散る', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 50 } });
    expect((await b.assign('mgr-1'))?.tokenId).toBe('a');
    state.loads = { a: 89, b: 5 };
    expect((await b.assign('mgr-2'))?.tokenId).toBe('b');
  });

  it('コンテナの鍵が閾値に達したら、新しい委譲だけ空いている鍵へ移り、以後はその鍵へ寄せる。動いている委譲は移さない', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 50 } });
    await b.assign('mgr-1', { container: 'runner-1' });
    state.loads = { a: 90, b: 50 };

    expect((await b.assign('mgr-2', { container: 'runner-1' }))?.tokenId).toBe('b');
    // 再開（prior）は止まるまで替えない
    expect((await b.assign('mgr-1', { prior: 'a', container: 'runner-1' }))?.tokenId).toBe('a');
    // b が a より混んできても、閾値未満なら b に寄せ続ける（行ったり来たりしない）
    state.loads = { a: 10, b: 60 };
    expect((await b.assign('mgr-3', { container: 'runner-1' }))?.tokenId).toBe('b');
  });

  it('測っていない鍵は閾値未満とみなし、使い続ける', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)]);
    expect((await b.assign('mgr-1', { container: 'runner-1' }))?.tokenId).toBe('a');
    state.loads = { b: 0 };
    expect((await b.assign('mgr-2', { container: 'runner-1' }))?.tokenId).toBe('a');
  });

  it('別のコンテナ（別の runner・クローン）は、それぞれの鍵を持つ', async () => {
    const { b } = book([token('a', 0), token('b', 1)]);
    const clone = await b.assign(CLONE_ASSIGNMENT_UNIT);
    const first = await b.assign('mgr-1', { container: 'runner-1' });
    const second = await b.assign('mgr-2', { container: 'runner-1' });
    expect(clone?.tokenId).toBe('a');
    expect(first?.tokenId).toBe('b');
    expect(second?.tokenId).toBe('b');
  });

  it('鍵が止まったら、同じコンテナの持ち主はまとまって同じ移り先へ移る', async () => {
    const { b, state } = book([token('a', 0), token('b', 1), token('c', 2)]);
    for (const id of ['mgr-1', 'mgr-2', 'mgr-3']) await b.assign(id, { container: 'runner-1' });
    expect(new Set(['mgr-1', 'mgr-2', 'mgr-3'].map((id) => b.target(id)?.tokenId))).toEqual(
      new Set(['a']),
    );
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1), token('c', 2)];

    const result = await b.evacuate('a');

    expect(new Set(result.moved.map((move) => move.to.tokenId)).size).toBe(1);
    expect(result.moved).toHaveLength(3);
    // 次の新しい委譲も同じ移り先へ寄る
    expect((await b.assign('mgr-4', { container: 'runner-1' }))?.tokenId).toBe(
      result.moved[0]?.to.tokenId,
    );
  });

  it('通る鍵が1本しか無ければ、閾値を超えていてもその鍵を使う（作業を止めない）', async () => {
    const { b } = book([token('a', 0), token('b', 1, { cooldownUntil: AT + 60_000 })], {
      loads: { a: 99 },
    });
    expect((await b.assign('mgr-1', { container: 'runner-1' }))?.tokenId).toBe('a');
    expect((await b.assign('mgr-2', { container: 'runner-1' }))?.tokenId).toBe('a');
  });

  it('引き取りの後（コンテナの記録が無い）は、そのコンテナの委譲がいちばん多く持つ鍵へ寄せる', async () => {
    const { b } = book([token('a', 0), token('b', 1), token('c', 2)], {
      loads: { a: 50, b: 50, c: 0 },
    });
    // 引き取った委譲が job に残った鍵（prior）で戻る
    await b.assign('mgr-1', { prior: 'b', container: 'runner-1' });
    await b.assign('mgr-2', { prior: 'b', container: 'runner-1' });
    await b.assign('mgr-3', { prior: 'a', container: 'runner-1' });

    expect((await b.assign('mgr-4', { container: 'runner-1' }))?.tokenId).toBe('b');
  });
});

describe('使用率が測れない鍵でも、偏りを戻す（#6649）', () => {
  const CONTAINERS = ['runner-1', 'runner-2', 'runner-3', 'runner-4', 'runner-5', 'runner-6'];

  function tokenOfContainer(b: ReturnType<typeof book>['b'], unit: string): string | undefined {
    return b.target(unit)?.tokenId;
  }

  it('一度の停止で全コンテナが片方へ寄っても、止まった鍵が戻れば、新しい作業から半々へ戻り、そこで止まる', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)]);
    for (const container of CONTAINERS) await b.assign(`${container}:m0`, { container });
    // 最初は散る（測れない鍵どうしは割り当て中の数で選ぶ）
    const first = CONTAINERS.map((c) => tokenOfContainer(b, `${c}:m0`));
    expect(first.filter((id) => id === 'a')).toHaveLength(3);

    // a が止まり、持ち主が b へ移る → 全コンテナが b
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1)];
    await b.evacuate('a');
    for (const container of CONTAINERS) {
      expect((await b.assign(`${container}:m1`, { container }))?.tokenId).toBe('b');
    }

    // a が戻る → 新しい作業を起こしたコンテナから a へ戻る
    state.tokens = [token('a', 0), token('b', 1)];
    const next: string[] = [];
    for (const container of CONTAINERS) {
      next.push((await b.assign(`${container}:m2`, { container }))?.tokenId ?? '');
    }
    expect(next.filter((id) => id === 'a')).toHaveLength(3);
    expect(next.filter((id) => id === 'b')).toHaveLength(3);

    // 半々になった後は、もう移さない（行ったり来たりしない）
    const again: string[] = [];
    for (const container of CONTAINERS) {
      again.push((await b.assign(`${container}:m3`, { container }))?.tokenId ?? '');
    }
    expect(again).toEqual(next);
  });

  it('差が 1 なら移さない（キャッシュを捨てるほどの偏りではない）', async () => {
    const { b } = book([token('a', 0), token('b', 1)]);
    // runner-1 → a、runner-2 → b、runner-3 → a（割り当て中の数で選ばれる）
    await b.assign('m1', { container: 'runner-1' });
    await b.assign('m2', { container: 'runner-2' });
    await b.assign('m3', { container: 'runner-3' });
    expect(['m1', 'm2', 'm3'].map((u) => b.target(u)?.tokenId)).toEqual(['a', 'b', 'a']);

    // runner-1 の次の作業: a に 2、b に 1 → 差 1 なので a のまま
    expect((await b.assign('m4', { container: 'runner-1' }))?.tokenId).toBe('a');
  });

  it('動いている作業（再開）は、偏っていても止まるまで替えない', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)]);
    for (const container of CONTAINERS.slice(0, 4))
      await b.assign(`${container}:m0`, { container });
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1)];
    await b.evacuate('a');
    state.tokens = [token('a', 0), token('b', 1)];

    expect((await b.assign('runner-1:m0', { prior: 'b', container: 'runner-1' }))?.tokenId).toBe(
      'b',
    );
  });

  it('測れる鍵は今どおり使用率の閾値で決める（コンテナの数では移さない）', async () => {
    const { b, state } = book([token('a', 0), token('b', 1)], { loads: { a: 10, b: 10 } });
    for (const container of CONTAINERS.slice(0, 4))
      await b.assign(`${container}:m0`, { container });
    state.tokens = [token('a', 0, { cooldownUntil: AT + 60_000 }), token('b', 1)];
    await b.evacuate('a');
    state.tokens = [token('a', 0), token('b', 1)];

    // b は 10% で閾値未満なので、4 コンテナが寄っていても使い続ける
    for (const container of CONTAINERS.slice(0, 4)) {
      expect((await b.assign(`${container}:m1`, { container }))?.tokenId).toBe('b');
    }
  });
});
