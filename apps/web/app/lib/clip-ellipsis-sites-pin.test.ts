import { describe, expect, it } from 'vitest';

import { clipLine } from './clip-line';
import { clipRawValue } from './clip-raw-value';

/**
 * 「…」付きの切り詰めを自前で書いている web の 2 か所を、外から縛る。
 * 仕様を先に書いたものではなく、今の出力から変えないための歯。寄せる前の各か所の違い（数え方）を固定する。
 *
 * - clipLine（clip-line.ts）: `redactBody`（伏せる）→ 空白を畳んで trim → コードポイントで max（引数）を数える
 * - clipRawValue（clip-raw-value.ts）: 前処理なし（trim も改行の畳みもしない）→ コードポイントで 40
 *
 * 2 か所ともコードポイントの数えで、サロゲートペアは割らない。既存の `clip-line.test.ts`・`clip-raw-value.test.ts` は
 * ASCII・あ・😀 の上限の前後と 1 件の境目だけで、結合文字・ZWJ・切り口が対の真ん中・前後の空白・空文字・改行の位置は縛っていないので足す。
 * 期待の値は `vitest -u` でインライン snapshot に生成し、目で読んで確かめた。
 * 長い文字列は、長さ（UTF-16 の u と コードポイントの cp）・頭・尻・孤立サロゲートの有無で表す。
 */

function shape(text: string | undefined): string {
  if (text === undefined) return 'undefined';
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
  const points = [...text];
  return (
    `${String(text.length)}u/${String(points.length)}cp ` +
    `head=${JSON.stringify(points.slice(0, 4).join(''))} tail=${JSON.stringify(points.slice(-4).join(''))}` +
    (lone ? ' LONE-SURROGATE' : '')
  );
}

const FAMILY = '👨‍👩‍👧';

function inputsFor(limit: number): Record<string, string> {
  return {
    '手前 a×(L-1)': 'a'.repeat(limit - 1),
    'ちょうど a×L': 'a'.repeat(limit),
    '1 超 a×(L+1)': 'a'.repeat(limit + 1),
    'ちょうど あ×L': 'あ'.repeat(limit),
    '1 超 あ×(L+1)': 'あ'.repeat(limit + 1),
    'a×(L-1)+😀（L cp・L+1 u）': `${'a'.repeat(limit - 1)}😀`,
    'a×(L-1)+😀+b（切り口が対の真ん中）': `${'a'.repeat(limit - 1)}😀b`,
    'a×(L-2)+😀+bb（対が切り口の手前に収まる）': `${'a'.repeat(limit - 2)}😀bb`,
    'a×(L-1)+😀😀': `${'a'.repeat(limit - 1)}😀😀`,
    '😀×L': '😀'.repeat(limit),
    '😀×(L+1)': '😀'.repeat(limit + 1),
    'a×(L-3)+家族(ZWJ)+z': `${'a'.repeat(limit - 3)}${FAMILY}z`,
    'a×(L-1)+é(結合)+x': `${'a'.repeat(limit - 1)}éx`,
    '改行を挟む a\\nb': 'a\nb',
    '前後に空白と改行 + a×L': ` \n ${'a'.repeat(limit)} \n`,
    'a×(L-1)+改行+b×5': `${'a'.repeat(limit - 1)}\n${'b'.repeat(5)}`,
    空文字: '',
    空白だけ: '  \n ',
  };
}

function table(limit: number, site: (text: string) => string | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputsFor(limit)).map(([name, text]) => [name, shape(site(text))]),
  );
}

describe('clipLine（clip-line.ts）: 伏せる → 空白を畳んで trim → コードポイントで max', () => {
  it('max=20 の各入力の結果', () => {
    expect(table(20, (text) => clipLine(text, 20))).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "21u/21cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "21u/21cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "21u/21cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "21u/21cp head="aaaa" tail="aa …"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "22u/21cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "22u/21cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "21u/20cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "22u/21cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "23u/21cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "20u/20cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "20u/20cp head="ああああ" tail="ああああ"",
        "前後に空白と改行 + a×L": "20u/20cp head="aaaa" tail="aaaa"",
        "手前 a×(L-1)": "19u/19cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a b" tail="a b"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "0u/0cp head="" tail=""",
        "😀×(L+1)": "41u/21cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "40u/20cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });

  it('max=120 でも同じ数え方', () => {
    expect(table(120, (text) => clipLine(text, 120))).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "121u/121cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "121u/121cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "121u/121cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "121u/121cp head="aaaa" tail="aa …"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "122u/121cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "122u/121cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "121u/120cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "122u/121cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "123u/121cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "120u/120cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "120u/120cp head="ああああ" tail="ああああ"",
        "前後に空白と改行 + a×L": "120u/120cp head="aaaa" tail="aaaa"",
        "手前 a×(L-1)": "119u/119cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a b" tail="a b"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "0u/0cp head="" tail=""",
        "😀×(L+1)": "241u/121cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "240u/120cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });

  it('max=0 は、空でなければ「…」だけ・空なら空文字', () => {
    expect([clipLine('abc', 0), clipLine('', 0), clipLine('😀', 0)]).toMatchInlineSnapshot(`
      [
        "…",
        "",
        "…",
      ]
    `);
  });

  it('伏せた後の字数で数える（伏せた形が上限の内か外かで「…」の有無が決まる）', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    expect([
      clipLine(`鍵 ${token} 以下略`, 8),
      clipLine(`鍵 ${token} 以下略`, 120),
      clipLine(token, 120),
    ]).toMatchInlineSnapshot(`
      [
        "鍵 [REDAC…",
        "鍵 [REDACTED] 以下略",
        "[REDACTED]",
      ]
    `);
  });
});

describe('clipRawValue（clip-raw-value.ts）: 前処理なし・コードポイントで 40', () => {
  it('各入力の結果', () => {
    expect(table(40, clipRawValue)).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "41u/41cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "41u/41cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "41u/41cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "41u/41cp head="aaaa" tail="aa\\n…"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "42u/41cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "42u/41cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "41u/40cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "42u/41cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "43u/41cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "40u/40cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "40u/40cp head="ああああ" tail="ああああ"",
        "前後に空白と改行 + a×L": "41u/41cp head=" \\n a" tail="aaa…"",
        "手前 a×(L-1)": "39u/39cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a\\nb" tail="a\\nb"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "4u/4cp head="  \\n " tail="  \\n "",
        "😀×(L+1)": "81u/41cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "80u/40cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });
});
