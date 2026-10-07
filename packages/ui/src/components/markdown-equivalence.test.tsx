import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markdownComponents, toReact } from './markdown';

function remarkGfmParseOnly(this: unknown) {
  const data = (
    this as {
      data(): { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
    }
  ).data();
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
}

function legacy(text: string, components: Components): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfmParseOnly, remarkBreaks],
        components,
        children: text,
      }),
    ),
  );
}

function current(text: string, components: Parameters<typeof toReact>[1]): string {
  return renderToStaticMarkup(createElement('div', null, toReact(text, components) as ReactNode));
}

const PREFIX = 'mdtest-';

// 旧実装の属性値の `footnote-label` だけを接頭辞付きに置き換えてから比べる: `mdast-util-to-hast` が `clobberPrefix` に関係なく固定で付け、旧実装には口が無いため
function legacyPrefixed(text: string, components: Components): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfmParseOnly, remarkBreaks],
        remarkRehypeOptions: { clobberPrefix: PREFIX + 'user-content-' },
        components,
        children: text,
      }),
    ),
  )
    .replaceAll('id="footnote-label"', `id="${PREFIX}footnote-label"`)
    .replaceAll('aria-describedby="footnote-label"', `aria-describedby="${PREFIX}footnote-label"`);
}

function currentPrefixed(text: string, components: Parameters<typeof toReact>[1]): string {
  return renderToStaticMarkup(
    createElement('div', null, toReact(text, components, PREFIX) as ReactNode),
  );
}

const FOOTNOTES = `本文[^a] と、もう一度[^a]、別の脚注[^b]。

[^a]: 最初の脚注。
[^b]: 2つ目の脚注。

    インデントした続きの段落。`;

const CORPUS: Array<[string, string]> = [
  ['h1', '# 見出し1'],
  ['h2', '## 見出し2'],
  ['h3', '### 見出し3'],
  ['h4', '#### 見出し4'],
  ['h5', '##### 見出し5'],
  ['h6', '###### 見出し6'],
  ['setext 見出し', '見出し\n===\n\n小見出し\n---'],
  ['見出し中の強調とコード', '## **太字** と `code` と [link](https://example.com)'],
  ['id 付きっぽい見出し', '# footnote-label'],
  ['段落', '一つ目の段落。\n\n二つ目の段落。'],
  ['単独改行', '1行目\n2行目\n3行目'],
  ['行末スペース2つの改行', '1行目  \n2行目'],
  ['行末バックスラッシュの改行', '1行目\\\n2行目'],
  ['先頭末尾の空白行', '\n\n本文\n\n\n'],
  ['強調', '*em* と _em_ と **strong** と __strong__ と ***both***'],
  ['取り消し線', '~~消す~~ と ~単独~ と ~~~三つ~~~'],
  ['入れ子の強調', '**太字の中の *斜体* と ~~取り消し~~**'],
  ['箇条書き', '- a\n- b\n- c'],
  ['入れ子リスト', '- a\n  - a1\n    - a11\n  - a2\n- b\n  1. b1\n  2. b2'],
  ['順序付き', '1. a\n2. b\n3. c'],
  ['順序付き start=3', '3. a\n4. b'],
  ['順序付き start=0', '0. a\n1. b'],
  ['順序付き start=1', '1. a\n1. b'],
  ['疎なリスト', '- a\n\n- b\n\n- c'],
  ['リスト項目内の段落とコード', '- a\n\n  段落\n\n  ```\n  code\n  ```\n- b'],
  ['アスタリスクのリスト', '* a\n* b\n+ c'],
  ['タスクリスト', '- [x] 済\n- [ ] 未\n- [X] 大文字'],
  ['タスクリスト（疎）', '- [x] 済\n\n- [ ] 未'],
  ['タスクリスト入れ子', '- [ ] 親\n  - [x] 子\n  - 普通の子'],
  ['順序付きタスク', '1. [x] a\n2. [ ] b'],
  [
    '表（揃え4種）',
    '| 左 | 中 | 右 | 無 |\n| :-- | :-: | --: | --- |\n| a | b | c | d |\n| e | f | g | h |',
  ],
  ['表（揃え無しのみ）', '| a | b |\n|---|---|\n| 1 | 2 |'],
  [
    '表（本文に強調とコードとリンク）',
    '| a | b |\n|---|---|\n| **x** | `y` |\n| [l](https://e.com) | ~~z~~ |',
  ],
  ['表（セル不足・過剰）', '| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |'],
  ['表の前後の段落', '前\n\n| a |\n|---|\n| 1 |\n\n後'],
  ['表（パイプのエスケープ）', '| a |\n|---|\n| x \\| y |'],
  ['表ヘッダのみ', '| a | b |\n|---|---|'],
  ['脚注（複数参照・戻るリンク）', FOOTNOTES],
  ['脚注（定義のみ）', '[^x]: 定義だけ'],
  ['脚注（参照のみ）', '参照だけ[^x]'],
  ['脚注（定義に強調とリンク）', '本文[^1]\n\n[^1]: **強調** と [link](https://example.com)'],
  ['脚注（日本語ラベル）', '本文[^注]\n\n[^注]: 日本語のラベル'],
  ['脚注（ラベルに記号）', '本文[^a b]と[^a&b]\n\n[^a&b]: 記号'],
  ['言語付きフェンス', '```ts\nconst a = 1;\n```'],
  ['言語無しフェンス（複数行）', '```\nline1\nline2\n```'],
  ['言語無しフェンス（1行）', '```\nonly\n```'],
  ['言語付き・属性付きフェンス', '```js {1,3} title="a"\nx\n```'],
  ['チルダのフェンス', '~~~py\nprint(1)\n~~~'],
  ['インデントコード', '段落\n\n    indented\n    code'],
  ['フェンス内の HTML と記号', '```html\n<div class="a">&amp; <b>x</b></div>\n```'],
  ['空のフェンス', '```\n```'],
  ['行内コード', '`a` と `` a`b `` と `<b>`'],
  ['フェンス内の罫線図', '```\n┌──┐\n│ a│\n└──┘\n```'],
  ['引用', '> 引用\n> 続き\n\n> 別の引用'],
  ['入れ子の引用', '> a\n>\n> > b\n> >\n> > - c'],
  ['引用の中のコードと表', '> ```\n> x\n> ```\n>\n> | a |\n> |---|\n> | 1 |'],
  ['hr（3種）', '---\n\n***\n\n___'],
  ['hr の前後', '前\n\n---\n\n後'],
  ['リンク', '[text](https://example.com "title")'],
  ['相対リンク', '[a](/path?x=1#h) [b](./rel) [c](#frag) [d](?q=1)'],
  ['参照リンク', '[ref][a] と [b]\n\n[a]: https://example.com "T"\n[b]: /rel'],
  ['画像', '![alt](https://example.com/a.png "title")'],
  ['画像（alt 無し・title 無し）', '![](https://example.com/a.png)'],
  ['画像参照', '![alt][img]\n\n[img]: https://example.com/a.png "T"'],
  ['画像参照（未定義）', '![alt][none]'],
  ['リンク参照（未定義）', '[text][none]'],
  ['画像を含むリンク', '[![alt](https://example.com/a.png)](https://example.com)'],
  ['autolink', '<https://example.com> と <mailto:a@example.com> と <a@example.com>'],
  [
    'リテラル autolink',
    'https://example.com と www.example.com と a@example.com と http://x.y/z?a=1&b=2.',
  ],
  ['リテラル autolink（括弧と句読点）', '(https://example.com/a_(b)) と https://example.com/a,'],
  ['javascript: リンク', '[x](javascript:alert(1))'],
  ['JavaScript: 大文字', '[x](JaVaScRiPt:alert(1))'],
  ['data: リンク', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
  ['vbscript: リンク', '[x](vbscript:msgbox(1))'],
  ['javascript: 画像', '![x](javascript:alert(1))'],
  ['data: 画像', '![x](data:image/png;base64,AAAA)'],
  ['javascript: 参照リンク', '[x][a]\n\n[a]: javascript:alert(1)'],
  ['javascript: autolink', '<javascript:alert(1)>'],
  [
    '許可プロトコル群',
    '[a](http://a.b) [b](HTTPS://a.b) [c](mailto:a@b) [d](xmpp:a@b) [e](irc://a.b) [f](ircs://a.b)',
  ],
  ['他のプロトコル', '[a](ftp://a.b) [b](tel:123) [c](file:///etc/passwd) [d](//a.b)'],
  ['コロンが後ろのパス', '[a](a/b:c) [b](a?b:c) [c](a#b:c)'],
  ['空の href', '[x]()'],
  ['エンコードが要る URL', '[x](https://example.com/日本語 あ?q=あ&r="x")'],
  ['script', '<script>alert(1)</script>'],
  ['onerror 付き img', '<img src=x onerror=alert(1)>'],
  [
    'インライン HTML',
    '文中の <b>太字</b> と <span style="color:red">色</span> と <br> と <a href="javascript:alert(1)">x</a>',
  ],
  ['ブロック HTML', '<div class="a">\n<p>in</p>\n</div>\n\n後'],
  ['HTML コメント', '前 <!-- コメント --> 後\n\n<!-- block -->'],
  ['HTML 内の Markdown', '<div>\n\n**強調**\n\n</div>'],
  [
    'iframe と style',
    '<iframe src="javascript:alert(1)"></iframe>\n\n<style>body{display:none}</style>',
  ],
  ['生 HTML と改行', '<b>a</b>\nb <i>c</i>\nd'],
  ['テーブル内の生 HTML', '| a |\n|---|\n| <b>x</b> |'],
  ['リスト内の生 HTML', '- <b>x</b>\n- y'],
  ['実体参照', '&amp; &lt; &gt; &quot; &copy; &#35; &#x1F600; &nbsp; &unknown;'],
  ['バックスラッシュエスケープ', '\\* \\_ \\# \\[ \\] \\\\ \\<b\\>'],
  ['特殊文字', '< > & " \' ` ~'],
  ['空文字列', ''],
  ['空白のみ', '   \n\n  '],
  [
    '日本語本文',
    '# 日報\n\n今日は**大事な**作業をした。\n\n- 項目A\n- 項目B\n\n> 引用。「かぎ括弧」と（全角括弧）。',
  ],
  ['日本語と改行', '一行目の日本語\n二行目の日本語\n\n三行目'],
  [
    'CRLF',
    '# a\r\n\r\n本文1\r\n本文2\r\n\r\n- x\r\n- y\r\n\r\n| a |\r\n|---|\r\n| 1 |\r\n\r\n```\r\ncode\r\n```\r\n',
  ],
  ['CR のみ', '行1\r行2\r\r行3'],
  ['BOM 付き', '﻿# 見出し'],
  ['タブとインデント', '\t- a\n\t- b\n\n-\ta\n-\tb'],
  ['絵文字と結合文字', '😀 👨‍👩‍👧 é é'],
  ['長い行', `${'あ'.repeat(3000)}\n${'x'.repeat(3000)}`],
  [
    '混在',
    '# タイトル\n\n本文 **強** *斜* ~~消~~ `code` [l](https://e.com)\n改行\n\n- [x] a\n- [ ] b\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n> 引用[^1]\n\n---\n\n```sh\nls\n```\n\n[^1]: 脚注',
  ],
  ['br の直後の空白（テキスト）', 'a  \n&#32;&#32;b'],
  ['br の直後の空白（強調の先頭）', 'a\\\n**&#x20;b**'],
  ['br の直後の空白（行内コードの先頭）', 'a  \n`  b`'],
  ['br の直後の空白（リンクの先頭）', 'a  \n[ x](u)'],
  ['br の直後の空白（取り消し線・タブ）', 'a  \n~~&#9; x~~'],
  ['br の直後に生 HTML', 'a  \n<b>x</b> y'],
  ['脚注（参照順と定義順が違う・再参照）', '[^b][^a][^b][^a][^b]\n\n[^a]: A\n[^b]: B'],
  ['脚注（3回参照）', 'x[^a] y[^a] z[^a]\n\n[^a]: 定義'],
  ['脚注（定義が重複・先勝ち）', 'x[^a]\n\n[^a]: 先\n\n[^a]: 後'],
  ['脚注（ラベルの大文字小文字）', 'x[^A] y[^a]\n\n[^a]: z'],
  ['脚注（未参照の定義が混ざる）', 'x[^a]\n\n[^a]: A\n[^unused]: U'],
  ['脚注（未定義の参照）', 'x[^none]'],
  ['脚注（空の定義）', 'x[^a]\n\n[^a]:'],
  ['脚注（定義の末尾が強調）', 'x[^a]\n\n[^a]: text **bold**'],
  ['脚注（定義の末尾が生 HTML）', 'x[^a]\n\n[^a]: text <b>x</b>'],
  ['脚注（定義の末尾がリスト）', 'x[^a]\n\n[^a]: 導入\n\n    - 項目1\n    - 項目2'],
  ['脚注（定義が複数段落）', 'x[^a]\n\n[^a]: 一段落\n\n    二段落'],
  ['脚注（定義の中で別の脚注を参照）', 'x[^a]\n\n[^a]: 脚注A[^b]\n[^b]: 脚注B[^a]'],
  [
    '脚注（表・リスト・引用の中の参照）',
    '| a[^1] |\n|---|\n| b |\n\n- c[^2]\n\n> d[^1]\n\n[^1]: 一\n[^2]: 二',
  ],
  [
    '脚注（記号のラベル・日本語の混在）',
    '本文[^注 1]と[^a/b]と[^%41]\n\n[^注 1]: 一\n[^a/b]: 二\n[^%41]: 三',
  ],
  ['参照（未定義・collapsed）', '[text][] と ![alt][]'],
  ['参照（未定義・full のラベル付き）', '[t][Label] と ![a][Label]'],
  ['参照（未定義・中身が強調）', '[*em* と `c`][none] と [**s**]'],
  ['参照（定義の重複・先勝ち・大文字小文字）', '[A] と [a]\n\n[a]: /first "先"\n[A]: /second'],
  ['参照（定義が引用の中）', '[x]\n\n> [x]: /in-quote'],
  ['参照（定義の title と空 URL）', '[x] [y]\n\n[x]: <> "T"\n[y]: /u'],
  ['リスト（一部の項目だけ疎）', '- a\n- b\n\n  c\n- d'],
  ['リスト（順序付き・項目内が2段落）', '1. a\n\n   b\n2. c'],
  ['リスト（start が大きい）', '10. a\n11. b'],
  [
    'リスト（項目内にコードと引用と表）',
    '- a\n  ```\n  c\n  ```\n  > q\n\n  | a |\n  |---|\n  | 1 |',
  ],
  ['リスト（空の項目）', '-\n- a\n-'],
  ['タスク（先頭が段落でない）', '- [x]\n\n  ```\n  code\n  ```'],
  ['タスク（本文が空）', '- [ ] \n- [x]'],
  ['タスク（取り消し線と強調が先頭）', '- [x] ~~a~~\n- [ ] **b**'],
  ['空の引用', '>\n\n> \n>'],
  ['引用の中のリスト', '> - a\n> - b\n>\n> 1. c'],
  ['表（空のセル）', '| a | b |\n|---|---|\n|  |  |'],
  ['表（セルの中の生 HTML の改行）', '| a |\n|---|\n| x<br>y |'],
  ['表（揃えより少ない列だけの行）', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 |'],
  ['行内コードの改行', '`a\nb` と `c\r\nd` と `e\rf`'],
  ['前後の空白と NBSP', 'a  \n b \t\n\tc'],
  ['画像の alt に記号', '![*a* `b` <x> "q"](u "t&t")'],
  ['サロゲートの片割れを含む URL', '[x](https://e.com/\ud800a) [y](😀) [z](%41%zz%) [w](a\ud83d)'],
  ['URL の記号', '[x](<a b> "T") [y](https://e.com/a[b]) [z](https://e.com/a%20b)'],
];

function repoDocs(): Array<[string, string]> {
  const root = resolve(__dirname, '../../../..');
  return [
    'AGENTS.md',
    'README.md',
    'docs/north_star.md',
    'docs/PRD.md',
    'docs/architecture.md',
  ].flatMap((file): Array<[string, string]> => {
    try {
      return [[`実在の文書: ${file}`, readFileSync(resolve(root, file), 'utf8')]];
    } catch {
      return [];
    }
  });
}

const ALL = [...CORPUS, ...repoDocs()];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<Markdown> の描画は react-markdown の旧実装と完全一致する', () => {
  it('コーパスは十分に広い（手で書いた節だけで 100 件近く）', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(100);
  });

  it.each(ALL)('%s（部品あり）', (_name, text) => {
    expect(current(text, markdownComponents)).toBe(legacy(text, markdownComponents as Components));
  });

  it.each(ALL)('%s（部品なし＝素の要素）', (_name, text) => {
    expect(current(text, {})).toBe(legacy(text, {}));
  });

  it('一致の比較が空振りしていない（出力が空でなく、タグを含む）', () => {
    const out = current('# a\n\n- [x] b\n\n| a |\n|:-:|\n| 1 |\n\nx[^1]\n\n[^1]: y', {});
    expect(out).toContain('<h1>a</h1>');
    expect(out).toContain('<input type="checkbox" disabled="" checked=""/>');
    expect(out).toContain('style="text-align:center"');
    expect(out).toContain('data-footnotes="true"');
    expect(out).toContain('aria-describedby="footnote-label"');
  });

  it.each(ALL)('%s（部品あり・脚注の id に接頭辞）', (_name, text) => {
    expect(currentPrefixed(text, markdownComponents)).toBe(
      legacyPrefixed(text, markdownComponents as Components),
    );
  });

  it.each(ALL)('%s（部品なし・脚注の id に接頭辞）', (_name, text) => {
    expect(currentPrefixed(text, {})).toBe(legacyPrefixed(text, {}));
  });

  it('接頭辞ありの比較が空振りしていない（脚注の id・href・aria-describedby が接頭辞付き）', () => {
    const md = 'x[^1]\n\n[^1]: y';
    const now = currentPrefixed(md, {});
    const before = legacyPrefixed(md, {});
    expect(now).toContain(`href="#${PREFIX}user-content-fn-1"`);
    expect(now).toContain(`id="${PREFIX}user-content-fnref-1"`);
    expect(now).toContain(`id="${PREFIX}user-content-fn-1"`);
    expect(now).toContain(`href="#${PREFIX}user-content-fnref-1"`);
    expect(now).toContain(`id="${PREFIX}footnote-label"`);
    expect(now).toContain(`aria-describedby="${PREFIX}footnote-label"`);
    expect(before).toContain(`id="${PREFIX}footnote-label"`);
    expect(before).not.toContain('"footnote-label"');
    expect(before).not.toContain('"user-content-');
    expect(before).not.toContain('"#user-content-');
  });

  it('キーなどの警告を出さず、旧実装が出す警告の集合とも一致する', () => {
    // 「出さない」ではなく「同じ」を見る: `![x](javascript:…)` の空の `src` の警告は旧実装も出すため
    const warnings = (run: (text: string) => string) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const [, text] of ALL) run(text);
      const calls = [...error.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
      vi.restoreAllMocks();
      return calls;
    };
    const now = warnings((t) => current(t, markdownComponents));
    const before = warnings((t) => legacy(t, markdownComponents as Components));
    expect(now.filter((m) => /key/i.test(m))).toEqual([]);
    expect(now).toEqual(before);
  });
});
