import { describe, expect, it } from 'vitest';

import { normalizeProfile } from './profile-compat.js';
import type { ProfileState } from './types.js';

// 型は新しい形を約束する。古いデーモンの応答は実行時にだけ型と食い違う（歯が測るのは実行時だけ）。
const asState = (value: unknown) => value as ProfileState;

describe('normalizeProfile', () => {
  it('新しい形はそのまま通す（legacy ではない）', () => {
    const raw = asState({
      entries: [
        { name: 'a', script: 'x\n', scope: 'runner', updatedAt: 'T', sha256: 's', bytes: 2 },
      ],
      clone: {},
      runner: { sha256: 'r' },
      script: 'x\n',
    });
    const out = normalizeProfile(raw);
    expect(out.legacy).toBe(false);
    expect(out.entries).toHaveLength(1);
    expect(out.runner).toEqual({ sha256: 'r' });
  });

  it('entries 無しの旧形式は default 行（all）1つとして、本文・指紋・更新日時を1文字も落とさず読む', () => {
    const out = normalizeProfile(
      asState({ script: 'export A=1\n', updatedAt: 'T', sha256: 'old', bytes: 11 }),
    );
    expect(out.legacy).toBe(true);
    expect(out.entries).toEqual([
      {
        name: 'default',
        script: 'export A=1\n',
        scope: 'all',
        updatedAt: 'T',
        sha256: 'old',
        bytes: 11,
      },
    ]);
    expect(out.script).toBe('export A=1\n');
    expect(out.clone).toEqual({});
  });

  it('旧形式で script が空・欠けても落ちず、行は0', () => {
    expect(normalizeProfile(asState({ script: '' })).entries).toEqual([]);
    expect(normalizeProfile(asState({})).entries).toEqual([]);
    expect(normalizeProfile(asState({})).legacy).toBe(true);
  });
});
