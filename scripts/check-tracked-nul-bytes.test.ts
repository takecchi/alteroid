import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir, makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';

// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { findNulByteHits, isPngImage, listScannableFiles, NUL_CHAR } from './check-tracked-nul-bytes-core.mjs';

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
 * 3. **実際の対象ファイル全体に対する検査そのもの**（下の
 *    `describe('実リポジトリの検査')`）— `check-web-bundle-node-traces` と
 *    同じ理由で、この歯はワークフローを変更せずに `pnpm test`（vitest。
 *    `.github/workflows/ci.yml` の既存の `pnpm test` ステップが
 *    `scripts/**\/*.test.ts` を拾う。`vitest.config.ts` の `include` 参照）
 *    へ足す。`pnpm build` は要らない（`listScannableFiles` は source を
 *    見るだけなので、生成物に依存しない）。**対象は追跡済み + 未追跡だが
 *    ignore されていないファイル**（Issue #1817。以前は追跡済みだけだった）。
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
    const dir = makeTempDirSync('check-tracked-nul-bytes-');
    const path = join(dir, 'has-nul.txt');
    writeFileSync(path, Buffer.from(['a', 'b', NUL_CHAR, 'c'].join('')));
    const content = readFileSync(path, 'utf8');
    const hits = findNulByteHits([{ path, content }]);
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe(path);
  });

  it('（対照）NUL の無い一時ファイルは緑になる', () => {
    const dir = makeTempDirSync('check-tracked-nul-bytes-');
    const path = join(dir, 'clean.txt');
    writeFileSync(path, 'abc');
    const content = readFileSync(path, 'utf8');
    const hits = findNulByteHits([{ path, content }]);
    expect(hits).toEqual([]);
  });
});

describe('isPngImage: 外すのは「.png かつ PNG のシグネチャ」だけ（#2722）', () => {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const text = new TextEncoder().encode('const x = "' + NUL_CHAR + '";\n');

  it('拡張子が .png でシグネチャで始まるものは外す', () => {
    expect(isPngImage('apps/web/public/icon.png', sig)).toBe(true);
  });

  it('.png を名乗っても、シグネチャで始まらない（NUL の混じったテキスト）なら外さない', () => {
    expect(isPngImage('apps/web/public/icon.png', text)).toBe(false);
  });

  it('シグネチャで始まっても、拡張子が .png でなければ外さない', () => {
    expect(isPngImage('apps/web/app/root.tsx', sig)).toBe(false);
  });

  it('シグネチャより短いものは外さない', () => {
    expect(isPngImage('a.png', sig.slice(0, 4))).toBe(false);
  });
});

describe('実リポジトリの検査（listScannableFiles が返す対象全ファイル）', () => {
  it('対象ファイルに NUL バイトが1つも無い', () => {
    const paths = listScannableFiles(ROOT) as string[];
    expect(paths.length).toBeGreaterThan(0);

    const files = [];
    for (const path of paths) {
      try {
        const bytes = readFileSync(join(ROOT, path));
        // PNG の画像だけは外す（`isPngImage`。`check-tracked-nul-bytes.mjs` と同じ扱い）
        if (isPngImage(path, bytes)) continue;
        files.push({ path, content: bytes.toString('utf8') });
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

describe('listScannableFiles は未追跡ファイルも対象に入れる（#1817）', () => {
  async function makeRepoWithUntrackedFile(): Promise<string> {
    const dir = await makeTempDir('check-tracked-nul-bytes-1817-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFileAsync(join(dir, 'tracked.txt'), 'tracked\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    // まだ `git add` していない新規ファイル（NUL バイトを含む）。
    await writeFileAsync(
      join(dir, 'new-untracked.txt'),
      Buffer.from(['a', NUL_CHAR, 'b'].join('')),
    );
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.txt');
  });

  it('🟢（直した後）: listScannableFiles は同じ新規ファイルを対象に入れ、NUL 混入を検出する', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const paths = listScannableFiles(dir) as string[];
    expect(paths).toContain('new-untracked.txt');

    const files = paths.map((path) => ({
      path,
      content: readFileSync(join(dir, path), 'utf8'),
    }));
    const hits = findNulByteHits(files);
    expect(hits.map((h: { path: string }) => h.path)).toContain('new-untracked.txt');
  });
});
