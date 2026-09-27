import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 付け忘れを防ぐ歯。
 *
 * `app.ts` の `jsonBody()` / `queryParams()` は、どちらも「`hook` を渡し忘れた
 * `validator('json'/'query', ...)` が1つでも残っていると、その経路だけ
 * `@hono/standard-validator` の既定の 400（`{ data, error, success }`——送られた
 * 値と英語の zod の issue をそのまま返す）に落ちる」という穴を、**ラッパーへ
 * 集約することでしか**塞いでいない。集約したのに、どこかの経路が
 * `validator('json', schema)` / `validator('query', schema)` を**直接**
 * 書いていたら、その1箇所だけ穴に逆戻りする——このテストはそれが起きて
 * いないことを静的に見る。
 *
 * **`app.ts` の中で `validator('json'|'query', ...)` の直接呼び出しが許されるのは
 * `jsonBody` / `queryParams` 自身の定義の中（1箇所ずつ）だけである。** それ以外の
 * 出現（コメント中の逐語言及を含む）が増えるのは構わないが、実際のコード呼び出し
 * （`validator('json', <schema>)` や `validator('query', <schema>, <hook>)` の形で
 * 第1引数に `'json'`/`'query'` を渡す呼び出し）が2箇所以上に増えたら赤くする。
 *
 * ## なぜ正規表現で数えるか（AST を使わない）
 *
 * `findRouteStatusMismatches`（#1633 再発防止の歯）は経路の網羅がテーマなので
 * AST を使っているが、ここで数えたいのは「`validator(` という関数呼び出しの
 * 第1引数リテラルが `'json'` または `'query'` である行」だけで、コメント中の
 * 数字のような曖昧さが無い——`validator('json'` という文字列そのものが
 * コード上に現れる箇所と、ラッパー定義の中の1箇所を突き合わせるだけで十分
 * 判定できる（doc コメント中の逐語言及だけを除く必要があるので、行頭が
 * `*`/`//` のコメント行は数えない）。
 */
describe("app.ts に validator('json'|'query', ...) の直接呼び出しが増えていない（付け忘れ防止の歯）", () => {
  const source = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');

  /** コメント行（`*` 始まり／`//` 始まり、前後の空白は無視）を除いた実コードの行。 */
  const codeLines = source.split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line));

  function countDirectCalls(target: 'json' | 'query'): number {
    const pattern = new RegExp(`validator\\(\\s*['"]${target}['"]`, 'g');
    return codeLines.reduce((count, line) => count + (line.match(pattern)?.length ?? 0), 0);
  }

  it("validator('json', ...) の直接呼び出しは jsonBody() の定義1箇所だけ", () => {
    expect(
      countDirectCalls('json'),
      "【赤の意味】app.ts のどこかで validator('json', ...) を直接呼んでいる（jsonBody() 経由に" +
        'なっていない）。hook を渡し忘れると、その経路だけ英語の zod の JSON と本文そのものが' +
        '400 でそのまま返る（issue #424 と同じ穴）。',
    ).toBe(1);
  });

  it("validator('query', ...) の直接呼び出しは queryParams() の定義1箇所だけ", () => {
    expect(
      countDirectCalls('query'),
      "【赤の意味】app.ts のどこかで validator('query', ...) を直接呼んでいる（queryParams() 経由に" +
        'なっていない）。hook を渡し忘れると、その経路だけ英語の zod の JSON とクエリそのものが' +
        '400 でそのまま返る（この PR が塞いだのと同じ穴に逆戻りしている）。',
    ).toBe(1);
  });
});
