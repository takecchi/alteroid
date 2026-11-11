import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { pluginListCommand } = await import('./plugin.js');
const { renderTasks } = await import('./tasks.js');
const { withdrawnMessageText, WITHDRAWN_MESSAGE_LABEL } = await import('./withdrawn-message.js');

/**
 * 「…」付きの切り詰めを自前で書いている cli の 3 か所を、外から縛る。
 * 仕様を先に書いたものではなく、今の出力から変えないための歯。寄せる前の各か所の違い（数え方）を固定する。
 *
 * - shortDescription（plugin.ts）: 前処理なし（trim も改行の畳みもしない）→ コードポイントで 100
 * - excerptOf（tasks.ts）: 最初の空でない 1 行だけ・その行を trim → コードポイントで 80
 * - withdrawnMessageText（withdrawn-message.ts）: 空白を畳んで trim → コードポイントで 60。空なら「（取り下げた発言）」だけ
 *
 * 3 か所とも、切るのはコードポイントの数えで、サロゲートペアは割らない。
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
    '先頭が空行 + a×(L+1) + 改行 + 二行目': `\n  \n ${'a'.repeat(limit + 1)}\n二行目`,
    空文字: '',
    空白だけ: '  \n ',
  };
}

function table(limit: number, site: (text: string) => string | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputsFor(limit)).map(([name, text]) => [name, shape(site(text))]),
  );
}

describe('shortDescription（plugin.ts）: 前処理なし・コードポイントで 100', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function described(description: string): Promise<string> {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plugins: [
            {
              name: 'demo',
              source: { kind: 'url', url: 'https://example.invalid/r.git', sha: 'a'.repeat(40) },
              scope: 'all',
              enableHooks: false,
              enableMcp: false,
              description,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const read = captureStdout();
    await pluginListCommand();
    const text = read();
    const marker = '\n    説明: ';
    const start = text.indexOf(marker);
    expect(text.endsWith('\n')).toBe(true);
    return text.slice(start + marker.length, -1);
  }

  it('各入力の結果', async () => {
    const out: Record<string, string> = {};
    for (const [name, text] of Object.entries(inputsFor(100))) {
      out[name] = shape(await described(text));
      vi.restoreAllMocks();
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "101u/101cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "101u/101cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "101u/101cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "101u/101cp head="aaaa" tail="aa\\n…"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "102u/101cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "102u/101cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "101u/100cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "102u/101cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "103u/101cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "100u/100cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "100u/100cp head="ああああ" tail="ああああ"",
        "先頭が空行 + a×(L+1) + 改行 + 二行目": "101u/101cp head="\\n  \\n" tail="aaa…"",
        "前後に空白と改行 + a×L": "101u/101cp head=" \\n a" tail="aaa…"",
        "手前 a×(L-1)": "99u/99cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a\\nb" tail="a\\nb"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "4u/4cp head="  \\n " tail="  \\n "",
        "😀×(L+1)": "201u/101cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "200u/100cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });
});

describe('excerptOf（tasks.ts）: 最初の空でない 1 行を trim・コードポイントで 80', () => {
  function excerpt(body: string): string {
    const out = renderTasks(
      {
        entries: [
          {
            id: 't1',
            status: 'queued',
            origin: 'human',
            title: 'T',
            body,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        unreadable: [],
      },
      Date.parse('2026-10-01T00:00:00.000Z'),
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]!.startsWith('      ')).toBe(true);
    return lines[2]!.slice(6);
  }

  it('各入力の結果', () => {
    expect(table(80, excerpt)).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "81u/81cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "81u/81cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "81u/81cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "79u/79cp head="aaaa" tail="aaaa"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "82u/81cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "82u/81cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "81u/80cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "82u/81cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "83u/81cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "80u/80cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "80u/80cp head="ああああ" tail="ああああ"",
        "先頭が空行 + a×(L+1) + 改行 + 二行目": "81u/81cp head="aaaa" tail="aaa…"",
        "前後に空白と改行 + a×L": "80u/80cp head="aaaa" tail="aaaa"",
        "手前 a×(L-1)": "79u/79cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "1u/1cp head="a" tail="a"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "0u/0cp head="" tail=""",
        "😀×(L+1)": "161u/81cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "160u/80cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });
});

describe('withdrawnMessageText（withdrawn-message.ts）: 空白を畳んで trim・コードポイントで 60', () => {
  function preview(text: string): string {
    const out = withdrawnMessageText(text);
    expect(out.startsWith(WITHDRAWN_MESSAGE_LABEL)).toBe(true);
    return out.slice(WITHDRAWN_MESSAGE_LABEL.length);
  }

  it('各入力の結果（ラベルの後ろ）', () => {
    expect(table(60, preview)).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "61u/61cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "61u/61cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "61u/61cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "61u/61cp head="aaaa" tail="aa …"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "62u/61cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "62u/61cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "61u/60cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "62u/61cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "63u/61cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "60u/60cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "60u/60cp head="ああああ" tail="ああああ"",
        "先頭が空行 + a×(L+1) + 改行 + 二行目": "61u/61cp head="aaaa" tail="aaa…"",
        "前後に空白と改行 + a×L": "60u/60cp head="aaaa" tail="aaaa"",
        "手前 a×(L-1)": "59u/59cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a b" tail="a b"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "0u/0cp head="" tail=""",
        "😀×(L+1)": "121u/61cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "120u/60cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });

  it('本文が空なら、ラベルだけを返す', () => {
    expect(withdrawnMessageText('')).toMatchInlineSnapshot(`"（取り下げた発言）"`);
    expect(withdrawnMessageText(' \n ')).toMatchInlineSnapshot(`"（取り下げた発言）"`);
  });
});
