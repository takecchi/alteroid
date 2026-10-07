import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findInvalidCssHits,
  PATTERNS,
  PLACEHOLDER_ELLIPSIS,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-web-css-comment-classnames-core.mjs';

// ビルドが無いときは黙ってスキップせず落とす: スキップすると「検査していない」が「検査して0件だった」と区別できなくなるため。
describe('check-web-css-comment-classnames: findInvalidCssHits', () => {
  it('プレースホルダ無しなら0件を返す', () => {
    const hits = findInvalidCssHits([
      { path: 'clean.css', content: '.grid-cols-\\[6rem_1fr\\]{grid-template-columns:6rem 1fr}' },
    ]);
    expect(hits).toEqual([]);
  });

  it('#317 で実際に生成された不正な calc() を捕まえる（半角ピリオド3つ）', () => {
    const content =
      '.pr-\\[calc\\(\\.\\.\\.\\+var\\(--safe-right\\)\\)\\]{padding-right:calc(...+var(--safe-right))}';
    const hits = findInvalidCssHits([{ path: 'root.css', content }]);
    expect(hits.map((h: { pattern: string }) => h.pattern)).toContain('placeholder-ellipsis');
  });

  it('全角省略記号（…）も捕まえる', () => {
    const content = '.foo{content:"…"}';
    const hits = findInvalidCssHits([{ path: 'root.css', content }]);
    expect(hits.map((h: { pattern: string }) => h.pattern)).toContain('placeholder-ellipsis');
  });

  it('⚠️ 回帰: text-overflow:ellipsis のような正当な語には反応しない', () => {
    const content = '.truncate{text-overflow:ellipsis;overflow:hidden}';
    expect(PLACEHOLDER_ELLIPSIS.test(content)).toBe(false);
    const hits = findInvalidCssHits([{ path: 'root.css', content }]);
    expect(hits).toEqual([]);
  });

  it('検査語は1つのまま（増減したらこのテストを更新して意図を明記すること）', () => {
    expect(PATTERNS.map((p: { name: string }) => p.name)).toEqual(['placeholder-ellipsis']);
  });
});

describe('実ビルドの検査（apps/web/build/client/assets/*.css）', () => {
  const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');

  it('コンパイル後の CSS に、コメントが誤って拾われた不正な宣言が無い', () => {
    if (!existsSync(ASSETS_DIR)) {
      throw new Error(
        `${ASSETS_DIR} が無い。先に \`pnpm build\` を走らせたか（AGENTS.md「開発手順」— build が先）`,
      );
    }
    const cssPaths = readdirSync(ASSETS_DIR)
      .map((name) => join(ASSETS_DIR, name))
      .filter((path) => statSync(path).isFile() && path.endsWith('.css'));

    expect(
      cssPaths.length,
      `${ASSETS_DIR} に .css が1つも無い（build が壊れていないか）`,
    ).toBeGreaterThan(0);

    const files = cssPaths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    const hits = findInvalidCssHits(files);

    expect(
      hits,
      hits
        .map(
          (h: { path: string; pattern: string; snippet: string }) =>
            `${h.path} : ${h.pattern}\n  …${h.snippet}…`,
        )
        .join('\n'),
    ).toEqual([]);
  });
});
