import { describe, expect, it } from 'vitest';

import { reportText } from './runner.js';

// クローンへ配る本文（`text`）は最後の発言、全文（`fullText`）は途中の発言を含めて捨てずに運ぶ
describe('reportText — 結論（最後の発言）と全文を分ける', () => {
  it('発言が1つなら全文と結論は同じで、fullText は載らない', () => {
    expect(reportText(['結論です'], { text: '結論です', empty: false })).toEqual({
      text: '結論です',
      contentless: false,
    });
  });

  it('途中の発言があれば、text は最後の発言・fullText は全部（順序どおり）', () => {
    const out = reportText(['main を確かめます', 'テストを回します', '## 結論\nPR #1 を出した'], {
      text: '## 結論\nPR #1 を出した',
      empty: false,
    });
    expect(out.text).toBe('## 結論\nPR #1 を出した');
    expect(out.fullText).toBe('main を確かめます\n\nテストを回します\n\n## 結論\nPR #1 を出した');
    expect(out.contentless).toBe(false);
  });

  it('result が最後の発言に含まれなければ、結論にも全文にも result を足す（黙って捨てない）', () => {
    const out = reportText(['途中', '最後'], { text: '別の結果', empty: false });
    expect(out.text).toBe('最後\n\n別の結果');
    expect(out.fullText).toBe('途中\n\n最後\n\n別の結果');
  });

  it('発言が無ければ result がそのまま本文になり、空なら contentless', () => {
    expect(reportText([], { text: '結果だけ', empty: false })).toEqual({
      text: '結果だけ',
      contentless: false,
    });
    expect(reportText([], { text: '（報告なし）', empty: true })).toEqual({
      text: '（報告なし）',
      contentless: true,
    });
  });
});
