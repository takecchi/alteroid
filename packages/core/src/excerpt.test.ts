import { describe, expect, it } from 'vitest';

import {
  codePointStartBoundary,
  countCodePoints,
  describePage,
  excerpt,
  excerptLine,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
  tailByCodePoints,
} from './excerpt.js';

describe('excerpt（1つの本文を切る）', () => {
  it('短ければ何も足さない（注記が毎回付くと目印が効かなくなる）', () => {
    expect(excerpt('みじかい', 10)).toBe('みじかい');
  });

  it('切ったら、省いた分量と全体の分量が付く', () => {
    const result = excerpt('あ'.repeat(30), 10);

    expect(result.startsWith('あ'.repeat(10))).toBe(true);
    expect(result).toContain('20 文字省略');
    expect(result).toContain('全 30 文字');
  });

  it('excerptLine は改行を潰す（1行に収めたい一覧のため）', () => {
    expect(excerptLine('あ\n\nい\tう ', 100)).toBe('あ い う');
  });
});

describe('renderListing（一覧を予算で積む）', () => {
  const omitted = ({ rest, shown, total }: { rest: number; shown: number; total: number }) =>
    `…ほか ${rest} 件は省略（全 ${total} 件のうち ${shown} 件）。`;

  it('予算に収まるなら全件そのまま出す', () => {
    const result = renderListing(['あ', 'い', 'う'], { budget: 100, omitted });

    expect(result).toBe('あ\nい\nう');
    expect(result).not.toContain('省略');
  });

  it('入らなかったぶんは断り書きになる（件数が出る）', () => {
    const items = Array.from({ length: 10 }, (_, index) => `${index}`.repeat(30));

    const result = renderListing(items, { budget: 100, omitted });

    expect(result).toContain('省略');
    expect(result).toContain('全 10 件');
  });

  it('**1件だけで予算を超えるときは、その1件を切って出す**', () => {
    const result = renderListing(['あ'.repeat(500)], { budget: 100, omitted });

    expect(result.length).toBeLessThan(200);
    expect(result).toContain('文字省略');
    expect(result).toContain('全 500 文字');
  });

  it('予算を超える先頭の1件があっても、残りの件数は黙らない', () => {
    const result = renderListing(['あ'.repeat(500), 'い', 'う'], { budget: 100, omitted });

    expect(result).toContain('ほか 2 件は省略');
  });

  it('空なら空文字（呼び手が「0件のときの言い方」を自分で決められる）', () => {
    expect(renderListing([], { budget: 100, omitted })).toBe('');
  });
});

describe('renderListingFromEnd（末尾を残して積む）', () => {
  const omitted = ({ rest, shown, total }: { rest: number; shown: number; total: number }) =>
    `…古い側 ${rest} 件は省略（全 ${total} 件のうち ${shown} 件）。`;

  it('予算に収まるなら全件そのまま、並びも変えない', () => {
    const result = renderListingFromEnd(['あ', 'い', 'う'], { budget: 100, omitted });

    expect(result).toBe('あ\nい\nう');
    expect(result).not.toContain('省略');
  });

  it('落とすのは古い側（先頭）で、残すのは新しい側（末尾）', () => {
    const items = Array.from({ length: 10 }, (_, index) => `[${index}]${'x'.repeat(30)}`);

    const result = renderListingFromEnd(items, { budget: 100, omitted });

    expect(result).toContain('[9]');
    expect(result).not.toContain('[0]');
    expect(result).toContain('省略');
  });

  it('断り書きは先頭に置く（穴が空いているのは古い側だから）', () => {
    const items = Array.from({ length: 10 }, (_, index) => `[${index}]${'x'.repeat(30)}`);

    const result = renderListingFromEnd(items, { budget: 100, omitted });

    expect(result.split('\n')[0]).toContain('省略');
  });

  it('1件だけで予算を超えるときは、その1件を切って出す', () => {
    const result = renderListingFromEnd(['あ'.repeat(500)], { budget: 100, omitted });

    expect(result.length).toBeLessThan(200);
    expect(result).toContain('文字省略');
  });

  it('空なら空文字', () => {
    expect(renderListingFromEnd([], { budget: 100, omitted })).toBe('');
  });
});

describe('page / describePage（全文を分けて渡す）', () => {
  it('続きがあることと、次の offset が分かる', () => {
    const part = page('あ'.repeat(100), 0, 40);

    expect(part.body).toBe('あ'.repeat(40));
    expect(part.to).toBe(40);
    expect(part.more).toBe(true);
    expect(describePage(part)).toBe('1〜40 文字目 / 全 100 文字');
  });

  it('最後まで出したら「全 N 文字」と言う（切れていないことが分かる）', () => {
    const part = page('あ'.repeat(30), 0, 40);

    expect(part.more).toBe(false);
    expect(describePage(part)).toBe('全 30 文字');
  });

  it('offset が本文より大きくても壊れない（空を返して続きは無いと言う）', () => {
    const part = page('あ'.repeat(10), 999, 40);

    expect(part.body).toBe('');
    expect(part.more).toBe(false);
  });
});

describe('renderListingEntry（実体の一覧の1件を決まった順で組む）', () => {
  const base = {
    id: 'x-1',
    title: '[札]',
    summary: '要旨の行',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('id と名前・作成と更新・概要を、この順で組む', () => {
    expect(renderListingEntry(base)).toBe(
      [
        '- x-1 [札]',
        '  作成: 2026-01-01T00:00:00.000Z / 更新: 2026-01-02T00:00:00.000Z',
        '  要旨の行',
      ].join('\n'),
    );
  });

  it('extra はそのまま概要の後ろへ続く（整形しない）', () => {
    const out = renderListingEntry({ ...base, extra: ['  状態: 未了', '  宛先: mgr-1'] });

    expect(out.split('\n').slice(3)).toEqual(['  状態: 未了', '  宛先: mgr-1']);
  });

  it('extra の null は落とす（条件つきの行をそのまま並べられる）', () => {
    const out = renderListingEntry({ ...base, extra: ['  先頭', null, '  末尾'] });

    expect(out.split('\n').slice(3)).toEqual(['  先頭', '  末尾']);
  });

  it('extra が無ければ3行だけになる', () => {
    expect(renderListingEntry(base).split('\n')).toHaveLength(3);
  });
});

describe('サロゲートペアを割らない（issue #1549）', () => {
  const isLoneHighSurrogateAtEnd = (text: string): boolean => {
    const last = text.charCodeAt(text.length - 1);
    return last >= 0xd800 && last <= 0xdbff;
  };

  it('🔴 excerpt: 切り口が絵文字の途中なら1つ手前で切り、省いた量はその位置で数える', () => {
    const text = 'A'.repeat(9) + '😀' + 'BBBB';
    const result = excerpt(text, 10);
    const body = result.slice(0, result.indexOf('…'));
    expect(body).toBe('A'.repeat(9));
    expect(isLoneHighSurrogateAtEnd(body)).toBe(false);
    expect(result).toContain('…（6 文字省略。全 15 文字）');
  });

  it('excerpt: 切り口が絵文字の後ろなら従来どおり（1文字も変えない）', () => {
    const text = 'A'.repeat(8) + '😀' + 'BBBB';
    expect(excerpt(text, 10)).toBe(`${'A'.repeat(8)}😀…（4 文字省略。全 14 文字）`);
  });

  it('🔴 page: 境目が絵文字の途中なら次のページへ回し、続けて読むと元の文字列に戻る', () => {
    const text = 'A'.repeat(9) + '😀' + 'B'.repeat(9) + '😀' + 'C';
    const first = page(text, 0, 10);
    expect(isLoneHighSurrogateAtEnd(first.body)).toBe(false);
    expect(first.to).toBe(9);
    let offset = 0;
    let joined = '';
    for (let i = 0; i < 20 && offset < text.length; i += 1) {
      const part = page(text, offset, 10);
      expect(isLoneHighSurrogateAtEnd(part.body)).toBe(false);
      joined += part.body;
      offset = part.to;
    }
    expect(joined).toBe(text);
  });

  it('page: limit が1で先頭が絵文字でも、止まらずに1コード単位は進む', () => {
    const part = page('😀X', 0, 1);
    expect(part.to).toBe(1);
  });
});

describe('tailByCodePoints（末尾をコードポイント数で切る。issue #1829）', () => {
  it('本文全体のコードポイント数が maxCodePoints 以下なら、全文をそのまま返す', () => {
    expect(tailByCodePoints('abcde', 5)).toBe('abcde');
    expect(tailByCodePoints('abcde', 100)).toBe('abcde');
  });

  it('本文が短くても maxCodePoints が0以下なら空文字を返す', () => {
    expect(tailByCodePoints('abcde', 0)).toBe('');
    expect(tailByCodePoints('abcde', -1)).toBe('');
  });

  it('真に長いときは末尾から maxCodePoints 個ぶんだけを返す（ASCII）', () => {
    expect(tailByCodePoints('abcdefghij', 3)).toBe('hij');
  });

  it('🔴 コードポイント数では maxCodePoints 以下だが UTF-16 長では超える本文も、全文を返す（絵文字。issue #1829 本体）', () => {
    const text = '\u{1F600}'.repeat(5);
    expect([...text]).toHaveLength(5);
    expect(text.length).toBe(10);
    expect(tailByCodePoints(text, 5)).toBe(text);
  });

  it('🔴 真に長いとき（絵文字）は、サロゲートペアの途中で切らない', () => {
    const text = '\u{1F600}'.repeat(10);
    const result = tailByCodePoints(text, 4);
    expect(result).toBe('\u{1F600}'.repeat(4));
    const lastCode = result.charCodeAt(0);
    expect(lastCode >= 0xdc00 && lastCode <= 0xdfff).toBe(false);
  });

  it('絵文字とASCIIが混在していても、末尾のコードポイント数どおりに切る', () => {
    const text = `AB${'\u{1F600}'.repeat(3)}CD`;
    expect(tailByCodePoints(text, 3)).toBe('\u{1F600}CD');
  });
});

describe('codePointStartBoundary（末尾を残す境界。issue #1829）', () => {
  it('境目が絵文字の途中（低位サロゲートの位置）なら1つ手前へ戻す', () => {
    const text = 'A😀B';
    expect(codePointStartBoundary(text, 2)).toBe(1);
  });

  it('境目が絵文字の境界どおりなら変えない', () => {
    const text = 'A😀B';
    expect(codePointStartBoundary(text, 1)).toBe(1);
    expect(codePointStartBoundary(text, 3)).toBe(3);
  });

  it('start が0以下、または文字列の長さ以上なら変えない', () => {
    const text = 'A😀B';
    expect(codePointStartBoundary(text, 0)).toBe(0);
    expect(codePointStartBoundary(text, text.length)).toBe(text.length);
  });
});

describe('countCodePoints（#1849）', () => {
  it('サロゲートペアは1つと数え、tailByCodePoints と同じ単位になる', () => {
    const text = 'a😀b😀';
    expect(text.length).toBe(6);
    expect(countCodePoints(text)).toBe(4);
    expect(tailByCodePoints(text, countCodePoints(text))).toBe(text);
    expect(tailByCodePoints(text, countCodePoints(text) - 1)).not.toBe(text);
  });

  it('空文字は0、孤立したサロゲートは1つと数える', () => {
    expect(countCodePoints('')).toBe(0);
    expect(countCodePoints('\ud83d')).toBe(1);
  });
});
