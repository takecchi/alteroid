import { describe, expect, it } from 'vitest';

import { renderMemoryDocument, renderMemoryDocuments } from './memory.js';

/**
 * 記憶をクローンの文脈へ載せる形。
 *
 * **ここが器（fs / pg / インメモリ）から移ってきたもの**なので、形そのものを
 * 1か所で固定する。器ごとに持っていた頃、インメモリ実装だけが見出しを付けて
 * おらず、しかもそれに気づける検査がどこにも無かった。
 *
 * 見出しの形（`<!-- memory: slug.md -->`）は**上の層が依存している**。走行中に
 * 変わった文書だけを載せ直すとき、システムプロンプトに載っている塊と同じ見出しで
 * 指せることが前提になっている（`clone.ts` の `#withFreshMemory`）。
 */
describe('記憶の載せ方', () => {
  it('人間が開くファイル名と同じ見出しを付ける', () => {
    expect(renderMemoryDocument({ slug: 'values', content: '# 価値観\n\nあ' })).toBe(
      '<!-- memory: values.md -->\n# 価値観\n\nあ',
    );
  });

  /**
   * 末尾の空白を落とす。**落とさないと文書の境目が見た目で動く** — 人間が
   * エディタで末尾に改行を足しただけで、載せ直しの差分に出る本文が変わる。
   */
  it('末尾の空白だけを落とす（先頭と本文には触らない）', () => {
    const rendered = renderMemoryDocument({ slug: 'a', content: '\n  先頭は残す\n\n\n' });

    expect(rendered).toBe('<!-- memory: a.md -->\n\n  先頭は残す');
    expect(rendered.endsWith('先頭は残す')).toBe(true);
  });

  it('文書のあいだは空行1つで、渡された順序のまま並ぶ', () => {
    expect(
      renderMemoryDocuments([
        { slug: 'b', content: 'に\n' },
        { slug: 'a', content: 'い\n' },
      ]),
    ).toBe('<!-- memory: b.md -->\nに\n\n<!-- memory: a.md -->\nい');
  });

  it('記憶が1つも無ければ空文字（「空」を言うのは呼び手の仕事である）', () => {
    expect(renderMemoryDocuments([])).toBe('');
  });
});
