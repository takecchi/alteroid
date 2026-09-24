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
  findTzApiHits,
  isTzPinned,
  judgeTzScan,
  needsTzPin,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない、この歯の中核）を読む
} from './check-test-tz-fixed-core.mjs';

/**
 * `check-test-tz-fixed-core.mjs` の歯（Issue #1192 N4）。
 *
 * 判定の範囲・限界・許可リストの理由は `check-test-tz-fixed-core.mjs` の doc
 * コメントに逐語で在る。ここはフィクスチャと本番スキャンだけを持つ。
 *
 * **フィクスチャの注意（`no-direct-mkdtemp.test.ts` と同じ罠を踏まないため）**:
 * このファイル自身が root の `vitest.config.ts` の `include`
 * （`scripts/**\/*.test.ts`）に一致するので、下の「本番スキャン」に自分自身も
 * 含まれる。フィクスチャで `new Date(2026, 0, 1)` や `.getHours()` のような
 * 検出対象そのものの字面をソースへ直接書くと、本番スキャンが自分自身を本物の
 * 違反として検出してしまう。だからフィクスチャは `N` / `OPEN_PAREN` を挟んで
 * 組み立て、ソース上に検出対象と同じ連続した文字列を残さない。
 */

const N = 2026;
const OPEN_PAREN = '(';

/** `new Date(2026, 0, 1)` のような呼び出しを、ソース上には検出対象と同じ
 * 連続したリテラルを残さずに組み立てる。 */
function newDateCall(): string {
  return `new Date${OPEN_PAREN}${N}, 0, 1)`;
}

/** `.getHours()` のような引数無し local getter 呼び出しを組み立てる。 */
function getterCall(name: string): string {
  return `.${name}${OPEN_PAREN})`;
}

describe('findTzApiHits（純粋関数）', () => {
  it('複数引数の new Date(年, 月, …) をカテゴリAとして検出する', () => {
    const content = `const at = ${newDateCall()};`;
    const hits = findTzApiHits([{ path: 'fake-a.test.ts', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'fake-a.test.ts', line: 1, category: 'A' });
  });

  it('.getHours() 等の引数無し local getter をカテゴリAとして検出する', () => {
    const content = `const h = at${getterCall('getHours')};\nconst d = at${getterCall('getDate')};`;
    const hits = findTzApiHits([{ path: 'fake-b.test.ts', content }]);
    expect(hits.filter((h: { category: string }) => h.category === 'A')).toHaveLength(2);
  });

  it('getUTCHours() 等の UTC 系 getter は対象外（カテゴリAの誤検出にならない）', () => {
    const content = `const h = at${getterCall('getUTCHours')};\nconst d = at${getterCall('getUTCDate')};`;
    const hits = findTzApiHits([{ path: 'fake-c.test.ts', content }]);
    expect(hits).toHaveLength(0);
  });

  it('.getSeconds() は TZ に依存しないので対象外', () => {
    const content = `const s = at${getterCall('getSeconds')};`;
    const hits = findTzApiHits([{ path: 'fake-d.test.ts', content }]);
    expect(hits).toHaveLength(0);
  });

  it('単一引数（タイムスタンプ）の new Date(...) はカテゴリAとして検出しない', () => {
    const content = `const at = new Date${OPEN_PAREN}Date.now());`;
    const hits = findTzApiHits([{ path: 'fake-e.test.ts', content }]);
    expect(hits).toHaveLength(0);
  });

  it('Number.toLocaleString(引数無しメソッド名の曖昧さ)は検出対象に含めない', () => {
    const content = `const s = chars.toLocaleString${OPEN_PAREN}'en-US');`;
    const hits = findTzApiHits([{ path: 'fake-f.test.ts', content }]);
    expect(hits).toHaveLength(0);
  });

  it('Intl.DateTimeFormat( を、近くに timeZone が無ければ非免除のカテゴリBとして検出する', () => {
    const content = [
      `const f = new Intl.DateTimeFormat${OPEN_PAREN}'en-US', {`,
      `  hour: '2-digit',`,
      `});`,
    ].join('\n');
    const hits = findTzApiHits([{ path: 'fake-g.test.ts', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ category: 'B', exempt: false });
  });

  it('Intl.DateTimeFormat( を、近くに timeZone があれば免除されたカテゴリBとして検出する', () => {
    const content = [
      `const f = new Intl.DateTimeFormat${OPEN_PAREN}'en-US', {`,
      `  timeZone: 'America/New_York',`,
      `});`,
    ].join('\n');
    const hits = findTzApiHits([{ path: 'fake-h.test.ts', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ category: 'B', exempt: true });
  });

  it('toLocaleDateString( / toLocaleTimeString( もカテゴリBとして検出する', () => {
    const content = [
      `const a = at.toLocaleDateString${OPEN_PAREN}'en-US');`,
      `const b = at.toLocaleTimeString${OPEN_PAREN}'en-US');`,
    ].join('\n');
    const hits = findTzApiHits([{ path: 'fake-i.test.ts', content }]);
    expect(hits.filter((h: { category: string }) => h.category === 'B')).toHaveLength(2);
  });

  it('timeZone の窓（NEARBY_WINDOW）を超えて離れていれば免除しない', () => {
    const filler = Array.from({ length: 8 }, (_, i) => `// line ${i}`).join('\n');
    const content = [
      `const f = new Intl.DateTimeFormat${OPEN_PAREN}'en-US', {`,
      filler,
      `  timeZone: 'America/New_York',`,
      `});`,
    ].join('\n');
    const hits = findTzApiHits([{ path: 'fake-j.test.ts', content }]);
    expect(hits[0]).toMatchObject({ category: 'B', exempt: false });
  });
});

describe('isTzPinned（純粋関数）', () => {
  it('process.env.TZ への代入を固定として認める', () => {
    expect(isTzPinned("process.env.TZ = 'Asia/Tokyo';")).toBe(true);
  });

  it("vi.stubEnv('TZ', …) を固定として認める", () => {
    expect(isTzPinned("vi.stubEnv('TZ', 'UTC');")).toBe(true);
  });

  it('TZ という語が出るだけでは固定と認めない（例: 変数名 tzOffset）', () => {
    expect(isTzPinned('const tzOffset = at.getTimezoneOffset();')).toBe(false);
  });
});

describe('needsTzPin（純粋関数）', () => {
  it('カテゴリAの hit が1つでもあれば固定必須', () => {
    const hits = [{ path: 'x', line: 1, matched: 'new Date(年, 月, …)', category: 'A' as const }];
    expect(needsTzPin(hits)).toBe(true);
  });

  it('カテゴリBだけで全部 exempt なら固定不要', () => {
    const hits = [
      { path: 'x', line: 1, matched: 'Intl.DateTimeFormat(', category: 'B' as const, exempt: true },
    ];
    expect(needsTzPin(hits)).toBe(false);
  });

  it('カテゴリBだけで exempt でないものが在れば固定必須', () => {
    const hits = [
      {
        path: 'x',
        line: 1,
        matched: 'Intl.DateTimeFormat(',
        category: 'B' as const,
        exempt: false,
      },
    ];
    expect(needsTzPin(hits)).toBe(true);
  });
});

describe('judgeTzScan（純粋関数、3値）', () => {
  it('走査対象が0ファイルなら「判定できない」', () => {
    const result = judgeTzScan([], [], new Map());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('scan-empty');
  });

  it('固定していないカテゴリAの hit が許可リストに無ければ「検出」', () => {
    const hits = [
      {
        path: 'not-allowlisted.test.ts',
        line: 1,
        matched: 'new Date(年, 月, …)',
        category: 'A' as const,
      },
    ];
    const result = judgeTzScan(['not-allowlisted.test.ts'], hits, new Map());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('violation');
    expect(result.message).toContain('not-allowlisted.test.ts');
  });

  it('カテゴリAの hit が許可リストに載っていれば合格', () => {
    const hits = [
      { path: 'legacy.test.ts', line: 1, matched: 'new Date(年, 月, …)', category: 'A' as const },
    ];
    const allowlist = new Map([['legacy.test.ts', '実測で TZ 非依存を確認済み']]);
    const result = judgeTzScan(['legacy.test.ts'], hits, allowlist);
    expect(result.ok).toBe(true);
  });

  it('免除されたカテゴリBだけの hit は許可リストが無くても合格', () => {
    const hits = [
      {
        path: 'fine.test.ts',
        line: 1,
        matched: 'Intl.DateTimeFormat(',
        category: 'B' as const,
        exempt: true,
      },
    ];
    const result = judgeTzScan(['fine.test.ts'], hits, new Map());
    expect(result.ok).toBe(true);
  });

  it('許可リストに載っているのに hit が無い（stale）と「検出」', () => {
    const allowlist = new Map([['already-fixed.test.ts', '固定済み（のはずだった）']]);
    const result = judgeTzScan(['already-fixed.test.ts'], [], allowlist);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('stale-allowlist');
    expect(result.message).toContain('already-fixed.test.ts');
  });

  it('カテゴリAの hit が在っても pinnedPaths に含まれていれば「要るのに無い」から除外され、許可リストが古びる', () => {
    const hits = [
      {
        path: 'self-pinned.test.ts',
        line: 1,
        matched: 'new Date(年, 月, …)',
        category: 'A' as const,
      },
    ];
    // 許可リストにまだ載っている（固定した後に消し忘れた想定）と stale で検出する
    const allowlist = new Map([['self-pinned.test.ts', '（固定した。消し忘れ）']]);
    const result = judgeTzScan(
      ['self-pinned.test.ts'],
      hits,
      allowlist,
      new Set(['self-pinned.test.ts']),
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('stale-allowlist');
  });

  it('カテゴリAの hit が在り pinnedPaths に含まれていれば、許可リストに無くても合格', () => {
    const hits = [
      {
        path: 'self-pinned2.test.ts',
        line: 1,
        matched: 'new Date(年, 月, …)',
        category: 'A' as const,
      },
    ];
    const result = judgeTzScan(
      ['self-pinned2.test.ts'],
      hits,
      new Map(),
      new Set(['self-pinned2.test.ts']),
    );
    expect(result.ok).toBe(true);
  });
});

describe('本番スキャン（このファイル自身も含め、repo 全体を実際に走査する）', () => {
  it('include に一致するテストファイルの TZ 依存 API 使用は、全部 TZ 固定済みか許可リストで説明できる', async () => {
    const includeGlobs = await readIncludeGlobs(ROOT);
    const matchedPaths = collectMatchingTestFiles(ROOT, includeGlobs);
    expect(matchedPaths.length).toBeGreaterThan(0); // 「判定できない」側に落ちていないことの前提

    const files = readFilesForScan(ROOT, matchedPaths);
    const pinnedPaths = new Set(
      files
        .filter((f: { content: string }) => isTzPinned(f.content))
        .map((f: { path: string }) => f.path),
    );
    const hits = findTzApiHits(files);
    const result = judgeTzScan(matchedPaths, hits, ALLOWLIST, pinnedPaths);

    expect(result.ok, result.ok ? undefined : result.message).toBe(true);
  });

  it('apps/web の2ファイル（reports.test.tsx / memory-detail.test.tsx）は自前の TZ 固定で説明できる（許可リスト不要）', async () => {
    const includeGlobs = await readIncludeGlobs(ROOT);
    const matchedPaths = collectMatchingTestFiles(ROOT, includeGlobs);
    const targets = [
      'apps/web/app/routes/reports.test.tsx',
      'apps/web/app/routes/memory-detail.test.tsx',
    ];
    for (const t of targets) expect(matchedPaths).toContain(t);
    const files = readFilesForScan(ROOT, matchedPaths).filter((f: { path: string }) =>
      targets.includes(f.path),
    );
    for (const f of files) {
      expect(isTzPinned(f.content), f.path).toBe(true);
      expect(ALLOWLIST.has(f.path), f.path).toBe(false);
    }
  });

  it('usage-reset-text.test.ts はカテゴリBのみで、timeZone を明示しているので許可リスト不要', async () => {
    const includeGlobs = await readIncludeGlobs(ROOT);
    const matchedPaths = collectMatchingTestFiles(ROOT, includeGlobs);
    const target = 'packages/core/src/usage-reset-text.test.ts';
    expect(matchedPaths).toContain(target);
    const files = readFilesForScan(ROOT, matchedPaths).filter(
      (f: { path: string }) => f.path === target,
    );
    const hits = findTzApiHits(files);
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((h: { category: string; exempt?: boolean }) => h.category === 'B' && h.exempt),
    ).toBe(true);
    expect(ALLOWLIST.has(target)).toBe(false);
  });
});
