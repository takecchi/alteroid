import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { findNulByteHits, NUL_CHAR } from './check-tracked-nul-bytes-core.mjs';

const ROOT = join(import.meta.dirname, '..');

/**
 * `check-tracked-nul-bytes` の歯（#260）。
 *
 * **3段構えである**（`check-web-css-comment-classnames.test.ts` と同じ形 —
 * 単体テスト → 実データに対する検査そのもの、に加えてここでは「一時ファイル
 * 経由でも本当に検出できるか」を挟む）。
 *
 * 1. **判定ロジックの単体テスト**（合成した文字列で当たり判定だけを確かめる）
 * 2. **一時ファイル経由の検出**（`check-tracked-nul-bytes.mjs` の実際の読み込み
 *    経路——`readFileSync(path, 'utf8')`——を通しても NUL が検出できることを、
 *    リポジトリを汚さない一時ファイルで確かめる）
 * 3. **実際に追跡済みの全ファイルに対する検査そのもの**（下の
 *    `describe('実リポジトリの検査')`）— `check-web-bundle-node-traces` と
 *    同じ理由で、この歯はワークフローを変更せずに `pnpm test`（vitest。
 *    `.github/workflows/ci.yml` の既存の `pnpm test` ステップが
 *    `scripts/**\/*.test.ts` を拾う。`vitest.config.ts` の `include` 参照）
 *    へ足す。`pnpm build` は要らない（`git ls-files` は追跡済みの source を
 *    見るだけなので、生成物に依存しない）。
 *
 * ## 経緯: 3.は一時期、既知の理由で赤かった
 *
 * `apps/daemon/src/cursor.test.ts` に、生の NUL バイトが1件混入していた
 * （`check-tracked-nul-bytes-core.mjs` の doc に実測の詳細）。**この検査は
 * それを除外しなかった**——除外すると、この検査が拾うべきものを自分で隠す
 * ことになる。その1件は、生の NUL バイトを読める表記（JS のエスケープ表記）
 * へ書き換えて解消した（文字列としての値は変えていない。意図か事故かは
 * 判定できておらず、両論を `cursor.test.ts` 本体に注記してある）。
 * ⟹ 除外リストは1件も無いまま、3.は現在は緑になる。
 */
describe('check-tracked-nul-bytes: findNulByteHits', () => {
  it('NUL 無しなら0件を返す', () => {
    const hits = findNulByteHits([{ path: 'clean.ts', content: 'export const x = 1;\n' }]);
    expect(hits).toEqual([]);
  });

  it('NUL が1個あれば検出する', () => {
    const content = 'const id = "  ' + NUL_CHAR + '  ";\n';
    const hits = findNulByteHits([{ path: 'dirty.ts', content }]);
    expect(hits.map((h: { path: string }) => h.path)).toEqual(['dirty.ts']);
  });

  it('複数ファイルのうち、NUL を含むものだけを返す', () => {
    const hits = findNulByteHits([
      { path: 'a.ts', content: 'clean' },
      { path: 'b.ts', content: 'has' + NUL_CHAR + 'nul' },
      { path: 'c.ts', content: 'clean too' },
    ]);
    expect(hits.map((h: { path: string }) => h.path)).toEqual(['b.ts']);
  });

  it('⚠️ 回帰: 見た目が近い文字（U+2400 SYMBOL FOR NULL 等）には反応しない', () => {
    // 「NUL に見える別の文字」で誤検知しないことを確かめる——検査語は
    // コードポイント0そのものであって、NUL を表す記号ではない。
    const hits = findNulByteHits([{ path: 'symbol.ts', content: 'looks-like-nul: ␀' }]);
    expect(hits).toEqual([]);
  });
});

describe('check-tracked-nul-bytes: 一時ファイル経由の検出', () => {
  it('NUL バイトを含む一時ファイルを実際に読み込んで検出する（リポジトリは汚さない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-tracked-nul-bytes-'));
    const path = join(dir, 'has-nul.txt');
    try {
      writeFileSync(path, Buffer.from(['a', 'b', NUL_CHAR, 'c'].join('')));
      const content = readFileSync(path, 'utf8');
      const hits = findNulByteHits([{ path, content }]);
      expect(hits.length).toBe(1);
      expect(hits[0].path).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('（対照）NUL の無い一時ファイルは緑になる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-tracked-nul-bytes-'));
    const path = join(dir, 'clean.txt');
    try {
      writeFileSync(path, 'abc');
      const content = readFileSync(path, 'utf8');
      const hits = findNulByteHits([{ path, content }]);
      expect(hits).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('実リポジトリの検査（git ls-files が返す追跡済み全ファイル）', () => {
  it('追跡済みファイルに NUL バイトが1つも無い', () => {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1024 * 1024 * 64 });
    const paths = out
      .toString('utf8')
      .split('\0')
      .filter((path: string) => path.length > 0);
    expect(paths.length).toBeGreaterThan(0);

    const files = [];
    for (const path of paths) {
      try {
        files.push({ path, content: readFileSync(join(ROOT, path), 'utf8') });
      } catch {
        // 読めないもの（壊れたシンボリックリンク等）は判定できないので飛ばす
        // （`check-tracked-nul-bytes.mjs` と同じ扱い）。
      }
    }

    const hits = findNulByteHits(files);

    expect(
      hits,
      hits.length === 0
        ? ''
        : `${hits.length}件のNULバイト混入:\n` +
            hits
              .map((h: { path: string; index: number }) => `  ${h.path} (offset ${h.index})`)
              .join('\n') +
            '\n除外リストは無い（#260）。表記を読める形へ書き換えて解消するか、' +
            '除外が本当に必要ならこのテストと doc の両方を更新すること。',
    ).toEqual([]);
  });
});
