import { describe, expect, it } from 'vitest';

import {
  describePage,
  excerpt,
  excerptLine,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
} from './excerpt.js';

/**
 * 抜粋 — **切るなら、切ったと分かる形で切る。**
 *
 * ここで測るのは「短くなること」ではなく「切ったことが受け取った側に届くこと」
 * である。前者だけを測ると、黙って落とす実装が通る。
 */
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

/**
 * 一覧を予算で積む形。**この repo が3回踏んだバグの、いまの置き場である。**
 *
 * `manager_list` が件数で溢れ（実測 52,997 文字）、`journal_read` が出力上限で
 * 丸ごと落ち、`digest` の6節が黙って切れた。3回とも「積むループが各実装の側に
 * あって、書き忘れても何も落ちなかった」という同じ形だったので、ここへ寄せた。
 */
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
    // 出した件数と全体の件数の両方が出る（片方だけでは欠落の大きさが分からない）
    expect(result).toContain('全 10 件');
  });

  it('**1件だけで予算を超えるときは、その1件を切って出す**', () => {
    // 落とすと「何も出ない一覧」になり、丸ごと出すと予算が意味を失う。
    // どちらも「上限がある」と言えなくなる。
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

/**
 * **落とす側が逆だと、いちばん要るものが消える。**
 *
 * 時系列に並んだ会話を先頭から積むと、予算で落ちるのは直近の発言になる。
 * 会話を開く動機はたいてい「さっきの続き」なので、そこが消えるのは一番効く
 * 場所が消えることであり、しかも断り書きは「もっと遡れ」と逆向きの続きの
 * 取り方を案内することになる。
 */
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

    // いちばん新しい `[9]` は残り、いちばん古い `[0]` は落ちる。
    expect(result).toContain('[9]');
    expect(result).not.toContain('[0]');
    expect(result).toContain('省略');
  });

  it('断り書きは先頭に置く（穴が空いているのは古い側だから）', () => {
    const items = Array.from({ length: 10 }, (_, index) => `[${index}]${'x'.repeat(30)}`);

    const result = renderListingFromEnd(items, { budget: 100, omitted });

    // 末尾に置くと「この下にまだある」と読める。穴は先頭にある。
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

/**
 * #231。**5項目を型で必須にした口。**
 *
 * 型が守るのは「呼び手が5つとも渡したか」だけで、**出力に出ているか**は
 * `tools.test.ts` の総当たり（「どの1件も id + 名前 / 作成 + 更新 / 概要 を
 * 決まった順で出す」）が見る。ここで測るのは**組み方そのもの**である。
 */
describe('renderListingEntry（実体の一覧の1件を決まった順で組む）', () => {
  const base = {
    id: 'x-1',
    title: '[札]',
    summary: '要旨の行',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('id と名前・作成と更新・概要を、この順で組む', () => {
    // **4つの日付を別々にしてある**ので、作成と更新を取り違えても落ちる。
    expect(renderListingEntry(base)).toBe(
      [
        '- x-1 [札]',
        '  作成: 2026-01-01T00:00:00.000Z / 更新: 2026-01-02T00:00:00.000Z',
        '  要旨の行',
      ].join('\n'),
    );
  });

  it('extra はそのまま概要の後ろへ続く（整形しない）', () => {
    // この関数は `extra` を整形しない。何を出すかは一覧ごとに違うので、
    // ここで畳むと嘘になる（呼び手が `  ` で始める約束）。
    const out = renderListingEntry({ ...base, extra: ['  状態: 未了', '  宛先: mgr-1'] });

    expect(out.split('\n').slice(3)).toEqual(['  状態: 未了', '  宛先: mgr-1']);
  });

  it('extra の null は落とす（条件つきの行をそのまま並べられる）', () => {
    // **先頭でも末尾でもない位置に null を置く** — 端だけ落とす実装でも通る形に
    // しないため。
    const out = renderListingEntry({ ...base, extra: ['  先頭', null, '  末尾'] });

    expect(out.split('\n').slice(3)).toEqual(['  先頭', '  末尾']);
  });

  it('extra が無ければ3行だけになる', () => {
    expect(renderListingEntry(base).split('\n')).toHaveLength(3);
  });
});
