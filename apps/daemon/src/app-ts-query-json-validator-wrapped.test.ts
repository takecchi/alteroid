import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe("app.ts に validator('json'|'query', ...) の直接呼び出しが増えていない（付け忘れ防止の歯）", () => {
  const source = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');

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
