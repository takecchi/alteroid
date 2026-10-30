import { describe, expect, it } from 'vitest';

import { plainPreview } from './plain-preview';

describe('plainPreview（会話の一覧の1行を素の文にする）', () => {
  it('クローンの返答の Markdown が、記号の無い1行になる', () => {
    expect(
      plainPreview('整理しました。 - 午前: 調査 - 午後: 実装 [リンク](https://example.com/x)'),
    ).toBe('整理しました。 午前: 調査 午後: 実装 リンク');
  });

  it('リンクは文字だけ残す。80字で切られて閉じていないリンクも', () => {
    expect(plainPreview('[docs](https://example.com/a) を見て')).toBe('docs を見て');
    expect(plainPreview('詳しくは [リンク](https://example.com/very/lo…')).toBe('詳しくは リンク');
  });

  it('見出しの #・強調・コードの記号を落とし、改行は空白にする', () => {
    expect(plainPreview('## 結果\n**太字** と *斜体* と __強調__ と `code`')).toBe(
      '結果 太字 と 斜体 と 強調 と code',
    );
    expect(plainPreview('# 題 ## 小題')).toBe('題 小題');
  });

  it('Markdown でない普通の文はそのまま', () => {
    for (const text of [
      'a*b と c*d を掛ける',
      'snake_case_name を直した',
      'C# と issue #12 の話',
      '2 * 3 = 6 と 5 - 3 = 2',
      '最初の発言です。',
      'https://example.com/a_b_c?x=1',
    ]) {
      expect(plainPreview(text)).toBe(text);
    }
  });
});
