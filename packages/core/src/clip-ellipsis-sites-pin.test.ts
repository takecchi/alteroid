import { describe, expect, it } from 'vitest';

import { ClassifierDenialStreaks } from './classifier-denial-streak.js';
import { summarizeRemovedForJournal } from './plugin-removed-summary.js';
import { describeWorkerLimit, WORKER_LIMIT_RAW_MAX_CHARS } from './runner-worker-limit-notice.js';

/**
 * 「…」付きの切り詰めを自前で書いている core の 3 か所を、外から縛る。
 * 仕様を先に書いたものではなく、今の出力から変えないための歯。寄せる前の各か所の違い（数え方）を固定する。
 *
 * - reasonHead（classifier-denial-streak.ts）: 空白を畳んで trim → コードポイントで 120 を数える
 * - truncateRaw（runner-worker-limit-notice.ts）: trim だけ（空白は畳まない）→ UTF-16 の .length で 300 を数え、`codePointBoundary` 無し
 * - cleanForJournal（plugin-removed-summary.ts）: 制御文字などを落とす → コードポイントで 120 を数える
 *
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

describe('reasonHead（classifier-denial-streak.ts）: 空白を畳んで trim・コードポイントで 120', () => {
  function head(reason: string | undefined): string | undefined {
    const streaks = new ClassifierDenialStreaks();
    streaks.noteDenial('manager', reason);
    return streaks.view('manager')?.firstReason;
  }

  it('各入力の結果', () => {
    expect(table(120, head)).toMatchInlineSnapshot(`
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
        "空文字": "undefined",
        "空白だけ": "undefined",
        "😀×(L+1)": "241u/121cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "240u/120cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });

  it('reason が undefined なら firstReason も undefined', () => {
    expect(head(undefined)).toMatchInlineSnapshot(`undefined`);
  });

  it('連続の途中の拒否の理由は上書きしない（最初の理由だけを切る）', () => {
    const streaks = new ClassifierDenialStreaks();
    streaks.noteDenial('manager', 'a'.repeat(121));
    streaks.noteDenial('manager', 'b'.repeat(121));
    expect(shape(streaks.view('manager')?.firstReason)).toMatchInlineSnapshot(
      `"121u/121cp head="aaaa" tail="aaa…""`,
    );
  });
});

describe('truncateRaw（runner-worker-limit-notice.ts）: trim だけ・UTF-16 の .length で 300・codePointBoundary 無し', () => {
  function raw(text: string): string {
    const described = describeWorkerLimit([{ label: 'L', raw: text }]);
    const start = described.indexOf('（原文: ');
    const end = described.indexOf('）。', start);
    return described.slice(start + '（原文: '.length, end === -1 ? undefined : end);
  }

  it('上限の定数は 300', () => {
    expect(WORKER_LIMIT_RAW_MAX_CHARS).toMatchInlineSnapshot(`300`);
  });

  it('各入力の結果', () => {
    expect(table(WORKER_LIMIT_RAW_MAX_CHARS, raw)).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "301u/301cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "301u/301cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "301u/301cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "301u/301cp head="aaaa" tail="aa\\n…"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "301u/301cp head="aaaa" tail="aa\\ud83d…" LONE-SURROGATE",
        "a×(L-1)+😀😀": "301u/301cp head="aaaa" tail="aa\\ud83d…" LONE-SURROGATE",
        "a×(L-1)+😀（L cp・L+1 u）": "301u/301cp head="aaaa" tail="aa\\ud83d…" LONE-SURROGATE",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "301u/300cp head="aaaa" tail="aa😀…"",
        "a×(L-3)+家族(ZWJ)+z": "301u/300cp head="aaaa" tail="a👨‍…"",
        "ちょうど a×L": "300u/300cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "300u/300cp head="ああああ" tail="ああああ"",
        "前後に空白と改行 + a×L": "300u/300cp head="aaaa" tail="aaaa"",
        "手前 a×(L-1)": "299u/299cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a\\nb" tail="a\\nb"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "0u/0cp head="" tail=""",
        "😀×(L+1)": "301u/151cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "301u/151cp head="😀😀😀😀" tail="😀😀😀…"",
      }
    `);
  });
});

describe('cleanForJournal（plugin-removed-summary.ts）: 制御文字を落としてコードポイントで 120', () => {
  function pathPart(path: string): string {
    const summary = summarizeRemovedForJournal([{ plugin: 'p', path, reason: 'not-allowlisted' }]);
    const prefix = 'not-allowlisted 1件（p:';
    expect(summary?.startsWith(prefix)).toBe(true);
    return summary!.slice(prefix.length, -1);
  }

  it('各入力の結果（path 側）', () => {
    expect(table(120, pathPart)).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "121u/121cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "121u/121cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "121u/121cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "121u/121cp head="aaaa" tail="aab…"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "122u/121cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "122u/121cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "121u/120cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "122u/121cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "124u/121cp head="aaaa" tail="👨👩👧…"",
        "ちょうど a×L": "120u/120cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "120u/120cp head="ああああ" tail="ああああ"",
        "前後に空白と改行 + a×L": "121u/121cp head="  aa" tail="aaa…"",
        "手前 a×(L-1)": "119u/119cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "2u/2cp head="ab" tail="ab"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "3u/3cp head="   " tail="   "",
        "😀×(L+1)": "241u/121cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "240u/120cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });

  it('plugin 名にも同じ切り方が掛かる', () => {
    const summary = summarizeRemovedForJournal([
      { plugin: 'a'.repeat(121), path: 'x', reason: 'not-allowlisted' },
    ]);
    expect(shape(summary ?? undefined)).toMatchInlineSnapshot(
      `"143u/143cp head="not-" tail="…:x）""`,
    );
  });
});
