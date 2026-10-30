import { describe, expect, it } from 'vitest';

import { normalizeProfile } from './profile-compat.js';
import type { ProfileState } from './types.js';

const asState = (value: unknown) => value as ProfileState;

describe('normalizeProfile', () => {
  it('新しい形はそのまま通す', () => {
    const raw = asState({
      entries: [
        { name: 'a', script: 'x\n', scope: 'runner', updatedAt: 'T', sha256: 's', bytes: 2 },
      ],
      clone: {},
      runner: { sha256: 'r' },
      script: 'x\n',
    });
    const out = normalizeProfile(raw);
    expect(out.entries).toHaveLength(1);
    expect(out.runner).toEqual({ sha256: 'r' });
  });

  it('clone・runner が欠けていれば空で補う', () => {
    const out = normalizeProfile(asState({ entries: [] }));
    expect(out.clone).toEqual({});
    expect(out.runner).toEqual({});
  });

  it('entries の無い応答は、旧い形として読み替えずに投げる', () => {
    const message = 'プロファイルの応答が読めない形で届いた（entries が無い）';
    expect(() => normalizeProfile(asState({ script: 'export A=1\n' }))).toThrow(message);
    expect(() => normalizeProfile(asState({ script: '' }))).toThrow(message);
    expect(() => normalizeProfile(asState({}))).toThrow(message);
  });
});
