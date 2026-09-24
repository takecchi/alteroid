import { describe, expect, it } from 'vitest';

import { describeTokenDiff, diffTokens, TOKEN_DIFF_SHOWN } from './token-diff.js';

describe('diffTokens / describeTokenDiff（#1306 案B）', () => {
  it('⭐ 見出しが全部残ったまま、UUID の真ん中だけが入れ替わった書き戻しを拾う（#1306 の実例）', () => {
    const before = '## 委譲\n\n対象は `1f2323f6-03a2-4570-8765-ec976924b7a5` である。\n';
    const after = '## 委譲\n\n対象は `1f2323f6-8570-4a58-8fc3-ec976924b7a5` である。\n';
    const note = describeTokenDiff(before, after);
    expect(note).toContain('消えた: `1f2323f6-03a2-4570-8765-ec976924b7a5`');
    expect(note).toContain('増えた: `1f2323f6-8570-4a58-8fc3-ec976924b7a5`');
  });

  it('本文中の数字の入れ替わりを拾う（4本 → 3本）', () => {
    expect(diffTokens('必須チェックは 4本 である', '必須チェックは 3本 である')).toEqual({
      removed: ['4'],
      added: ['3'],
    });
  });

  it('増減が無ければ null（応答に1文字も足さない）。語順の入れ替えも増減ではない', () => {
    expect(describeTokenDiff('a 1 `x` 2', 'a 2 `x` 1 b')).toBeNull();
  });

  it('新規作成（前が無い）は null —— 比べる相手が無い', () => {
    expect(describeTokenDiff(null, '1 2 3')).toBeNull();
  });

  it('同じものが何回在るかも比べる（多重集合）', () => {
    expect(diffTokens('1 1', '1')).toEqual({ removed: ['1'], added: [] });
  });

  it('件数が多いときは上限まで並べ、残りは件数だけ出す', () => {
    const before = Array.from({ length: TOKEN_DIFF_SHOWN + 3 }, (_, i) => String(i)).join(' ');
    expect(describeTokenDiff(before, '')).toContain('ほか 3 件');
  });
});
