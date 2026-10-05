import { describe, expect, it } from 'vitest';

import {
  classifyTokenPolicyChange,
  classifyTokenPoolChange,
  type AgentToken,
} from './token-pool.js';

const row = (id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken => ({
  id,
  label: id,
  value: `dummy-${id}`,
  order,
  ...extra,
});

describe('classifyTokenPoolChange（#2742）', () => {
  const base = [row('a', 0), row('b', 1), row('c', 2)];
  const ops = (after: AgentToken[]) =>
    classifyTokenPoolChange(base, after).map((change) => `${change.operation}:${change.id}`);

  it('差分なし・order の数値だけの変更（並びは同じ）は何も出さない', () => {
    expect(ops(base)).toEqual([]);
    expect(ops([row('a', 10), row('b', 20), row('c', 30)])).toEqual([]);
  });

  it('追加・削除・無効化・有効化・改名', () => {
    expect(ops([...base, row('d', 3)])).toEqual(['add:d']);
    expect(ops([base[0]!, base[1]!])).toEqual(['remove:c']);
    expect(ops([base[0]!, row('b', 1, { disabledAt: 'x' }), base[2]!])).toEqual(['disable:b']);
    const disabled = [row('a', 0), row('b', 1, { disabledAt: 'x' })];
    expect(
      classifyTokenPoolChange(disabled, [row('a', 0), row('b', 1)]).map((c) => c.operation),
    ).toEqual(['enable']);
    expect(ops([base[0]!, { ...base[1]!, label: 'renamed' }, base[2]!])).toEqual(['rename:b']);
  });

  it('広げる側は widens: true（追加・有効化・値の差し替え・並べ替え）、狭める側は false', () => {
    const widens = (after: AgentToken[]) =>
      classifyTokenPoolChange(base, after).map((change) => change.widens);
    expect(widens([...base, row('d', 3)])).toEqual([true]);
    expect(widens([base[0]!, base[1]!])).toEqual([false]);
    expect(widens([{ ...base[0]!, value: 'dummy-other' }, base[1]!, base[2]!])).toEqual([true]);
    expect(widens([row('c', 0), row('a', 1), row('b', 2)]).includes(true)).toBe(true);
  });

  it('結果に値は入らない', () => {
    const text = JSON.stringify(
      classifyTokenPoolChange(base, [{ ...base[0]!, value: 'dummy-new' }]),
    );
    expect(text).not.toContain('dummy-');
  });
});

describe('classifyTokenPolicyChange（#2742）', () => {
  const before = { rotateOn: 'free_exhausted', cooldownMs: 1000, updatedAt: 't' } as const;
  it('off へ狭める（冷却を一緒に変えても）は狭める側', () => {
    expect(classifyTokenPolicyChange(before, { rotateOn: 'off', cooldownMs: 1000 }).widens).toBe(
      false,
    );
    expect(classifyTokenPolicyChange(before, { rotateOn: 'off', cooldownMs: 5 }).widens).toBe(
      false,
    );
  });
  it('off から戻す・契機を変える・冷却を変えるは広げる側。差分なしは何も無い', () => {
    const off = { ...before, rotateOn: 'off' } as const;
    expect(
      classifyTokenPolicyChange(off, { rotateOn: 'free_exhausted', cooldownMs: 1000 }).widens,
    ).toBe(true);
    expect(
      classifyTokenPolicyChange(before, { rotateOn: 'overage_exhausted', cooldownMs: 1000 }).widens,
    ).toBe(true);
    expect(
      classifyTokenPolicyChange(before, { rotateOn: 'free_exhausted', cooldownMs: 2 }).widens,
    ).toBe(true);
    expect(classifyTokenPolicyChange(before, before)).toEqual({ changes: [], widens: false });
  });
  it('現在値が読めない（undefined）ときは両項目が変更で、off 以外は広げる側', () => {
    const r = classifyTokenPolicyChange(undefined, { rotateOn: 'free_exhausted', cooldownMs: 1 });
    expect(r.changes).toHaveLength(2);
    expect(r.widens).toBe(true);
  });
});
