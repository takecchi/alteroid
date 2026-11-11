import { describe, expect, it } from 'vitest';

import {
  clipWithEllipsis,
  codePointStartBoundary,
  countCodePoints,
  describePage,
  excerpt,
  excerptLine,
  excerptRow,
  fillListingBudget,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
  tailByCodePoints,
} from './excerpt.js';

describe('clipWithEllipsis（注記なしで「…」だけを付けて切る）', () => {
  it('上限以下ならそのまま（ちょうど上限も切らない）', () => {
    expect(clipWithEllipsis('あいう', 3)).toBe('あいう');
    expect(clipWithEllipsis('', 0)).toBe('');
  });

  it('上限を超えたら上限で切って … を付ける', () => {
    expect(clipWithEllipsis('あいうえ', 3)).toBe('あいう…');
  });

  it('上限はコードポイントで数える: 切り口にかかった補助面の文字は落とさず残す', () => {
    expect(clipWithEllipsis('ab😀c', 3)).toBe('ab😀…');
    expect(clipWithEllipsis('ab😀c', 2)).toBe('ab…');
    expect(clipWithEllipsis('😀😀😀', 2)).toBe('😀😀…');
  });

  it('補助面の文字だけで UTF-16 の長さが上限を超えても、コードポイントが上限以下なら切らない', () => {
    expect(clipWithEllipsis('😀😀😀', 3)).toBe('😀😀😀');
    expect(clipWithEllipsis('ab😀', 3)).toBe('ab😀');
  });

  it('どの上限でも、結果に孤立したサロゲートが残らない', () => {
    const text = 'a😀b😀😀c𠮷d';
    for (let limit = -1; limit <= 12; limit += 1) {
      expect(clipWithEllipsis(text, limit)).not.toMatch(/\p{Surrogate}/u);
    }
  });

  it('上限ちょうどは切らず、1 つ超えたら切る', () => {
    expect(clipWithEllipsis('abc', 3)).toBe('abc');
    expect(clipWithEllipsis('abcd', 3)).toBe('abc…');
    expect(clipWithEllipsis('😀😀', 2)).toBe('😀😀');
    expect(clipWithEllipsis('😀😀😀', 2)).toBe('😀😀…');
  });

  it('上限が 0 以下: 空文字は空文字のまま、それ以外は … だけ', () => {
    expect(clipWithEllipsis('', 0)).toBe('');
    expect(clipWithEllipsis('', -1)).toBe('');
    expect(clipWithEllipsis('abc', 0)).toBe('…');
    expect(clipWithEllipsis('abc', -1)).toBe('…');
    expect(clipWithEllipsis('😀', 0)).toBe('…');
  });

  it('ZWJ・結合文字の途中でも、コードポイントの境界で切る（書記素までは見ない）', () => {
    // 👨‍👩‍👧 = 👨 ZWJ 👩 ZWJ 👧（5 コードポイント）
    expect(clipWithEllipsis('👨‍👩‍👧x', 2)).toBe('👨‍…');
    expect(clipWithEllipsis('👨‍👩‍👧x', 5)).toBe('👨‍👩‍👧…');
    // e + 結合アクセント
    expect(clipWithEllipsis('éé', 1)).toBe('e…');
    expect(clipWithEllipsis('éé', 2)).toBe('é…');
  });

  it('入力にもとから孤立サロゲートがあっても、1 つのコードポイントとして数えて落ちない', () => {
    expect(clipWithEllipsis('a\ud83dbc', 2)).toBe('a\ud83d…');
  });
});

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

  // 「11〜10 文字目」のような逆転した範囲で空の本文を返すと、呼び手は「空の文書」と読み違える
  it('⭐ offset が末尾を越えた回は、範囲を逆転させず「末尾を越えていて本文は無い」と言う', () => {
    const part = page('あ'.repeat(10), 999, 40);

    expect(describePage(part)).toBe(
      '全 10 文字の末尾を越えている（offset が全体の長さ以上）。この位置に本文は無い',
    );
  });

  it('空の本文（0 文字）は今までどおり「全 0 文字」と言う', () => {
    expect(describePage(page('', 0, 40))).toBe('全 0 文字');
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

  it('🔴 excerpt: 上限はコードポイントで数える（絵文字は 1 字。落とさず残し、割らない）', () => {
    const text = 'A'.repeat(9) + '😀' + 'BBBB';
    const result = excerpt(text, 10);
    const body = result.slice(0, result.indexOf('…'));
    expect(body).toBe('A'.repeat(9) + '😀');
    expect(isLoneHighSurrogateAtEnd(body)).toBe(false);
    expect(result).toContain('…（4 文字省略。全 14 文字）');
  });

  it('excerpt: 切り口が絵文字の後ろ（補助面の文字を挟んだ先）でも、コードポイントで数える', () => {
    const text = 'A'.repeat(8) + '😀' + 'BBBB';
    expect(excerpt(text, 10)).toBe(`${'A'.repeat(8)}😀B…（3 文字省略。全 13 文字）`);
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

  it('🔴 page: offset がサロゲートペアの後半に当たったら、その文字の頭から読む（単独の低サロゲートから始めない）', () => {
    const text = 'A😀B';
    const part = page(text, 2, 10);
    expect(part.from).toBe(1);
    expect(part.body).toBe('😀B');
    expect(describePage(part)).toBe('2〜4 文字目 / 全 4 文字');
  });

  it('page: offset が境目に乗っていれば、今までどおりその位置から読む', () => {
    const text = 'A😀B';
    expect(page(text, 1, 10).body).toBe('😀B');
    expect(page(text, 3, 10).body).toBe('B');
  });

  it('page: limit が1なら頭へ戻さない（戻すと同じ位置へ戻り続けて先へ進めないため）', () => {
    const text = '😀X';
    let offset = 0;
    const seen: number[] = [];
    for (let i = 0; i < 5 && offset < text.length; i += 1) {
      const part = page(text, offset, 1);
      expect(part.to).toBeGreaterThan(offset);
      seen.push(part.to);
      offset = part.to;
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('excerpt・excerptLine・excerptRow はコードポイントで数える', () => {
  const noLoneSurrogate = (text: string): boolean =>
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

  it('空・短い・ちょうど: 何も足さない（補助面を含んでも）', () => {
    expect(excerpt('', 10)).toBe('');
    expect(excerpt('', 0)).toBe('');
    expect(excerpt('abc', 3)).toBe('abc');
    // UTF-16 の長さ 20 > 10 でも、コードポイントは 10 でちょうど: 切らない
    expect(excerpt('😀'.repeat(10), 10)).toBe('😀'.repeat(10));
    expect(excerptRow('😀'.repeat(10), 10)).toBe('😀'.repeat(10));
    expect(excerptLine('😀 '.repeat(5).trim(), 10)).toBe('😀 😀 😀 😀 😀');
  });

  it('1 超: 先頭 limit コードポイント + 注記（N はコードポイント数）', () => {
    expect(excerpt('abcd', 3)).toBe('abc…（1 文字省略。全 4 文字）');
    expect(excerpt('😀'.repeat(11), 10)).toBe(`${'😀'.repeat(10)}…（1 文字省略。全 11 文字）`);
    expect(excerptRow('abcd', 3)).toBe('abc…（全 4 字）');
    expect(excerptRow('😀'.repeat(11), 10)).toBe(`${'😀'.repeat(10)}…（全 11 字）`);
    expect(excerptLine('😀😀\n\n😀😀', 3)).toBe('😀😀 …（2 文字省略。全 5 文字）');
  });

  it('絵文字 300 個: 旧は UTF-16 で「360 文字省略。全 600 文字」、新は「60 文字省略。全 300 文字」', () => {
    expect(excerpt('😀'.repeat(300), 240)).toBe(`${'😀'.repeat(240)}…（60 文字省略。全 300 文字）`);
  });

  it('limit が 0: 本文を出さず注記だけ。負も 0 と同じ（空文字は空のまま）', () => {
    expect(excerpt('abc', 0)).toBe('…（3 文字省略。全 3 文字）');
    expect(excerpt('😀😀', 0)).toBe('…（2 文字省略。全 2 文字）');
    expect(excerpt('abc', -5)).toBe('…（3 文字省略。全 3 文字）');
    expect(excerpt('', -1)).toBe('');
    expect(excerptRow('abc', 0)).toBe('…（全 3 字）');
    expect(excerptRow('abc', -5)).toBe('…（全 3 字）');
    expect(excerptRow('', -1)).toBe('');
  });

  it('ZWJ・結合文字はコードポイントで切る（書記素までは見ない）', () => {
    // 👨‍👩‍👧 = 👨 ZWJ 👩 ZWJ 👧（5 コードポイント）
    const family = '👨‍👩‍👧';
    expect(countCodePoints(family)).toBe(5);
    expect(excerpt(`${family}X`, 3)).toBe('👨‍👩…（3 文字省略。全 6 文字）');
    // e + 結合アクセント（2 コードポイント）
    expect(excerptRow('ééé', 3)).toBe('ée…（全 6 字）');
  });

  it('切り口で孤立サロゲートを出さない（どの位置で切っても）', () => {
    const text = 'A😀B😀C😀D';
    for (let limit = 0; limit <= 8; limit += 1) {
      expect(noLoneSurrogate(excerpt(text, limit))).toBe(true);
      expect(noLoneSurrogate(excerptRow(text, limit))).toBe(true);
      expect(noLoneSurrogate(excerptLine(text, limit))).toBe(true);
    }
  });

  it('fillListingBudget の予算は UTF-16 の出力量のまま（1 件目だけで超えるときは excerpt で切る）', () => {
    // 絵文字 10 個 = UTF-16 で 20 > 予算 10 → excerpt(…, 10) = 先頭 10 コードポイント（= 全部）。注記なし
    const { lines } = fillListingBudget(['😀'.repeat(10)], 10);
    expect(lines).toEqual(['😀'.repeat(10)]);
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
