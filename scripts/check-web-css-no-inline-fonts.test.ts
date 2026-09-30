import { describe, expect, it } from 'vitest';

import {
  assertHasCssFiles,
  FAILURE_ADVICE,
  findInlineFontHits,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-web-css-no-inline-fonts-core.mjs';

/**
 * `check-web-css-no-inline-fonts` の判定ロジックの歯（`check-web-css-comment-classnames.test.ts`
 * の1段目と同じ形）。本物の `pnpm build` を要らない。実ビルドへの検査は CI / `pnpm verify` が
 * `pnpm check:web-css-no-inline-fonts` として直接走らせる。
 */
describe('check-web-css-no-inline-fonts', () => {
  it('data:font がある CSS を落とす（個数も数える）', () => {
    const content =
      '@font-face{src:url(data:font/woff2;base64,AAAA)}@font-face{src:url(data:font/woff;base64,BBBB)}';
    const hits = findInlineFontHits([{ path: 'root.css', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'root.css', count: 2 });
  });

  it('data:font が無い CSS を通す（URL 参照・画像の埋め込みは対象外）', () => {
    const content =
      '@font-face{src:url(/assets/a-abc.woff2) format("woff2")}.x{background:url(data:image/svg+xml;base64,CCCC)}';
    expect(findInlineFontHits([{ path: 'root.css', content }])).toEqual([]);
  });

  it('CSS が 0 本なら落ちる（空で緑にならない）', () => {
    expect(assertHasCssFiles([])).not.toBeNull();
    expect(assertHasCssFiles([{ path: 'root.css', content: '' }])).toBeNull();
  });

  it('落ちたときの説明に、原因の候補と困る理由が入っている', () => {
    expect(FAILURE_ADVICE).toContain('assetsInlineLimit');
    expect(FAILURE_ADVICE).toContain('unicode-range');
  });
});
