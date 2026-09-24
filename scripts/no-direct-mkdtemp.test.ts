import { describe, expect, it } from 'vitest';

import {
  collectMatchingTestFiles,
  readFilesForScan,
  readIncludeGlobs,
  ROOT,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
} from './test-guard-core.mjs';
import {
  ALLOWLIST,
  findDirectMkdtempCalls,
  judgeMkdtempScan,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない、この歯の中核）を読む
} from './no-direct-mkdtemp-core.mjs';

/**
 * `no-direct-mkdtemp-core.mjs` の歯（#1436 案B）。
 *
 * **フィクスチャの注意（`test-guard-core.test.ts` と同じ罠を踏まないため）**:
 * このファイル自身が root の `vitest.config.ts` の `include`
 * （`scripts/**\/*.test.ts`）に一致するので、下の「本番スキャン」に自分
 * 自身も含まれる。フィクスチャで「直接呼び出しが在ったら」を試すとき、
 * 呼び出しの識別子（`mkdtemp` / `mkdtempSync`）に開き括弧を直接つなげた
 * 文字列をソース上に連続したリテラルとして書くと、それがテストのつもり
 * でも本番スキャンが本物の違反として検出し、`pnpm test` がここで恒久的に
 * 赤くなる（**この doc コメントの最初の下書きが、まさにこの段落の説明の
 * ために識別子と開き括弧を連続させて書いてしまい、本番スキャンに自分自身
 * が引っかかって落ちた。`test-guard-core.test.ts` の同じ経緯を、書く前に
 * 読んでいたのに踏んだ**）。**だからフィクスチャの呼び出しは
 * `OPEN_PAREN` を挟んで組み立て、ソース上に連続した文字列を作らない。**
 */

const OPEN_PAREN = '(';

/** `mkdtemp` / `mkdtempSync` を呼び出す形（識別子の直後に開き括弧が続く形）を、
 * ソース上には連続したリテラルを残さずに組み立てる。 */
function callText(name: 'mkdtemp' | 'mkdtempSync'): string {
  return name + OPEN_PAREN;
}

describe('findDirectMkdtempCalls（純粋関数）', () => {
  it('named import 形式の呼び出しを検出する', () => {
    const content = `import { ${'mkdtemp'} } from 'node:fs/promises';\nconst dir = await ${callText('mkdtemp')}join(tmpdir(), 'x-'));`;
    const hits = findDirectMkdtempCalls([{ path: 'fake-a.test.ts', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'fake-a.test.ts', line: 2 });
  });

  it('mkdtempSync（named import）形式の呼び出しを検出する', () => {
    const content = `const dir = ${callText('mkdtempSync')}join(tmpdir(), 'x-'));`;
    const hits = findDirectMkdtempCalls([{ path: 'fake-b.test.ts', content }]);
    expect(hits).toHaveLength(1);
  });

  it('namespace import 形式（fs.mkdtempSync）の呼び出しも検出する', () => {
    const content = `const dir = fs.${callText('mkdtempSync')}path.join(os.tmpdir(), 'x-'));`;
    const hits = findDirectMkdtempCalls([{ path: 'fake-c.test.ts', content }]);
    expect(hits).toHaveLength(1);
  });

  it('動的 import からの分割代入経由の呼び出しも検出する', () => {
    const content = [
      `const { ${'mkdtempSync'}, rmSync } = await import('node:fs');`,
      `const dir = ${callText('mkdtempSync')}join(tmpdir(), 'x-'));`,
    ].join('\n');
    const hits = findDirectMkdtempCalls([{ path: 'fake-d.test.ts', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it('import 文だけ（呼び出していない）では検出しない', () => {
    const content = `import { mkdtemp, mkdtempSync } from 'node:fs/promises';\nconst x = 1;`;
    const hits = findDirectMkdtempCalls([{ path: 'fake-e.test.ts', content }]);
    expect(hits).toHaveLength(0);
  });

  it('helper（makeTempDir / makeTempDirSync）の呼び出しは対象外', () => {
    const content = `const dir = await makeTempDir('x-');\nconst dir2 = makeTempDirSync('y-');`;
    const hits = findDirectMkdtempCalls([{ path: 'fake-f.test.ts', content }]);
    expect(hits).toHaveLength(0);
  });

  it('1ファイルに複数箇所あれば複数件返す', () => {
    const content = [callText('mkdtemp'), callText('mkdtempSync'), callText('mkdtemp')]
      .map((c) => `const d = ${c}x);`)
      .join('\n');
    const hits = findDirectMkdtempCalls([{ path: 'fake-g.test.ts', content }]);
    expect(hits).toHaveLength(3);
    expect(hits.map((h: { line: number }) => h.line)).toEqual([1, 2, 3]);
  });
});

describe('judgeMkdtempScan（純粋関数、3値）', () => {
  it('走査対象が0ファイルなら「判定できない」', () => {
    const result = judgeMkdtempScan([], [], new Map());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('scan-empty');
  });

  it('許可リストに無い hit が在れば「検出」', () => {
    const hits = [{ path: 'not-allowlisted.test.ts', line: 1, matched: callText('mkdtemp') }];
    const result = judgeMkdtempScan(['not-allowlisted.test.ts'], hits, new Map());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('violation');
    expect(result.message).toContain('not-allowlisted.test.ts');
  });

  it('hit が全部許可リストに載っていれば合格', () => {
    const hits = [{ path: 'legacy.test.ts', line: 1, matched: callText('mkdtemp') }];
    const allowlist = new Map([['legacy.test.ts', '移行待ち']]);
    const result = judgeMkdtempScan(['legacy.test.ts'], hits, allowlist);
    expect(result.ok).toBe(true);
  });

  it('許可リストに載っているのに hit が無い（stale）と「検出」', () => {
    const allowlist = new Map([['already-migrated.test.ts', '移行待ち（のはずだった）']]);
    const result = judgeMkdtempScan(['already-migrated.test.ts'], [], allowlist);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('stale-allowlist');
    expect(result.message).toContain('already-migrated.test.ts');
  });
});

describe('本番スキャン（このファイル自身も含め、repo 全体を実際に走査する）', () => {
  it('include に一致するテストファイルの直接呼び出しは、全部許可リストで説明できる', async () => {
    const includeGlobs = await readIncludeGlobs(ROOT);
    const matchedPaths = collectMatchingTestFiles(ROOT, includeGlobs);
    expect(matchedPaths.length).toBeGreaterThan(0); // 「判定できない」側に落ちていないことの前提

    const files = readFilesForScan(ROOT, matchedPaths);
    const hits = findDirectMkdtempCalls(files);
    const result = judgeMkdtempScan(matchedPaths, hits, ALLOWLIST);

    expect(result.ok, result.ok ? undefined : result.message).toBe(true);
  });

  it('許可リストに載っている間接呼び出し専用ファイル（cli-stub.ts）は *.test.ts ではないので、走査自体の対象に入らない', async () => {
    const includeGlobs = await readIncludeGlobs(ROOT);
    const matchedPaths = collectMatchingTestFiles(ROOT, includeGlobs);
    expect(matchedPaths).not.toContain('railway/cli-stub.ts');
  });

  it('railway/scale-runners.test.ts は cli-stub.ts 経由の間接呼び出しだけなので、許可リストに無くても検出されない', async () => {
    const includeGlobs = await readIncludeGlobs(ROOT);
    const matchedPaths = collectMatchingTestFiles(ROOT, includeGlobs);
    const files = readFilesForScan(ROOT, matchedPaths).filter(
      (f: { path: string }) => f.path === 'railway/scale-runners.test.ts',
    );
    expect(files).toHaveLength(1);
    expect(ALLOWLIST.has('railway/scale-runners.test.ts')).toBe(false);
    expect(findDirectMkdtempCalls(files)).toHaveLength(0);
  });
});
