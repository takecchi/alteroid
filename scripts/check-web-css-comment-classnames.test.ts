import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  findInvalidCssHits,
  PATTERNS,
  PLACEHOLDER_ELLIPSIS,
} from './check-web-css-comment-classnames-core.mjs';

/**
 * `check-web-css-comment-classnames` の歯（#317）。
 *
 * **2段構えである。**
 *
 * 1. **判定ロジックの単体テスト**（`check-web-bundle-node-traces.test.ts` と同じ形）—
 *    合成した文字列で当たり判定だけを確かめる。本物の `pnpm build` を要らない
 * 2. **実際のビルド生成物に対する検査そのもの**（下の `describe('実ビルドの検査')`）—
 *    `check-web-bundle-node-traces` は同じ検査を `.github/workflows/ci.yml` の
 *    別ステップ（`pnpm check:web-bundle-node-traces`）として CI に足しているが、
 *    **この歯はワークフローを変更せずに CI へ足す**ため、`pnpm test`
 *    （vitest。`.github/workflows/ci.yml` の既存の `pnpm test` ステップが
 *    `scripts/**\/*.test.ts` を拾う。`vitest.config.ts` の `include` 参照）
 *    が実行する **この test ファイル自身の中で** 実ビルドの CSS を読んで検査する。
 *    CI は `pnpm build` の後に `pnpm test` を走らせる（`ci.yml`）ので、この
 *    テストが走る時点で `apps/web/build/client/assets/*.css` は必ず存在する。
 *    手元で `pnpm build` を走らせずに `pnpm test` だけを打つと、下のテストは
 *    「先に `pnpm build` を走らせたか」というメッセージ付きで落ちる
 *    （`AGENTS.md`「開発手順」の `build が先` と同じ前提。黙ってスキップしない —
 *    スキップすると「検査していない」が「検査して0件だった」と区別できなくなる）。
 */
describe('check-web-css-comment-classnames: findInvalidCssHits', () => {
  it('プレースホルダ無しなら0件を返す', () => {
    const hits = findInvalidCssHits([
      { path: 'clean.css', content: '.grid-cols-\\[6rem_1fr\\]{grid-template-columns:6rem 1fr}' },
    ]);
    expect(hits).toEqual([]);
  });

  it('#317 で実際に生成された不正な calc() を捕まえる（半角ピリオド3つ）', () => {
    // 実測（#317 本文・PR #304 の作業者の報告）から取った断片。
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

    expect(cssPaths.length, `${ASSETS_DIR} に .css が1つも無い（build が壊れていないか）`).toBeGreaterThan(
      0,
    );

    const files = cssPaths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    const hits = findInvalidCssHits(files);

    expect(
      hits,
      hits
        .map((h: { path: string; pattern: string; snippet: string }) => `${h.path} : ${h.pattern}\n  …${h.snippet}…`)
        .join('\n'),
    ).toEqual([]);
  });
});
