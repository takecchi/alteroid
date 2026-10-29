import { describe, expect, it } from 'vitest';

import { UNREADABLE_IDS_SHOWN, unreadableIdsNote } from './unreadable-ids-note';

describe('unreadableIdsNote', () => {
  it('並べるものが無ければ null', () => {
    expect(unreadableIdsNote('id', [])).toBeNull();
  });

  it('上限以内なら全部を並べ、省略の断りは付けない', () => {
    expect(unreadableIdsNote('id', ['a', 'b'])).toBe('（id: a, b）');
  });

  it('見出しの名詞は引数で変わる', () => {
    expect(unreadableIdsNote('kind', ['x'])).toBe('（kind: x）');
  });

  it('上限を超えたら先頭から上限の件数だけ並べ、残りの件数を言う', () => {
    const all = Array.from({ length: UNREADABLE_IDS_SHOWN + 3 }, (_, i) => `r${i}`);
    const note = unreadableIdsNote('id', all);
    expect(note).toBe(`（id: ${all.slice(0, UNREADABLE_IDS_SHOWN).join(', ')} …ほか 3 件は省略）`);
  });

  it('上限ちょうどなら省略の断りは付けない', () => {
    const all = Array.from({ length: UNREADABLE_IDS_SHOWN }, (_, i) => `r${i}`);
    expect(unreadableIdsNote('id', all)).not.toContain('省略');
  });
});
