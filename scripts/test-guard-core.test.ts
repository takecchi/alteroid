import { describe, expect, it } from 'vitest';

import {
  EXIT_SCAN_EMPTY,
  EXIT_STATIC_SKIP,
  EXIT_UNKNOWN,
  EXIT_ZERO_PASSED,
  ROOT,
  collectMatchingTestFiles,
  findUnconditionalSkips,
  formatSkipGuardMessage,
  judgeExecution,
  judgeStaticSkipScan,
  parseAggregateLines,
  parsePassedCount,
  readIncludeGlobs,
  runStaticSkipGuard,
} from './test-guard-core.mjs';

/**
 * `test-guard-core.mjs` の歯（#311）。
 *
 * **フィクスチャの注意（この段落自体が一度この穴を踏んだ）**: このファイル
 * 自体が root の `vitest.config.ts` の `include`（`scripts/**\/*.test.ts`）に
 * 一致するので、歯Bの本番スキャン（`pnpm test` を実際に打ったときの走査）に
 * 自分自身も含まれる。**もしここへ `describe` `.` `skip` に続けて `(` が来る
 * 文字列をリテラルのまま書くと、それがテストのフィクスチャのつもりでも、
 * 歯Bの正規表現は生のソースを見るので「無条件の静的 skip」として誤検出し、
 * `pnpm test` がここで恒久的に赤くなる。**（実際、この段落の最初の下書きは
 * 説明のために `describe` の後ろへ `.skip(` を直接書いてしまい、歯Bの本番
 * スキャンに自分自身が引っかかって落ちた。プロダクトコードだけでなく、
 * この doc コメントの散文もスキャン対象であることを実地で確認した形である。）
 * だからフィクスチャの `skip` 呼び出しは文字列連結で組み立て、ソース上に
 * その連続した文字列が1つも現れないようにしてある（下の `dotSkip` ヘルパ）。
 * 評価後の文字列としては本物の skip 呼び出しの形になるので、
 * `findUnconditionalSkips` が読む「もし本物のソースがこう書かれていたら」を
 * 試すことに変わりはない。
 */

/** `.skip` を1トークンとしてソースに焼き込まないための組み立てヘルパ。 */
function dotSkip(each = false) {
  return '.' + 'skip' + (each ? '.each' : '');
}

describe('parseAggregateLines / parsePassedCount', () => {
  it('Test Files / Tests の集計行を両方読める', () => {
    const raw = [
      '...vitest banner...',
      ' Test Files  92 passed (92)',
      '      Tests  1542 passed (1542)',
      '   Duration  12.34s',
    ].join('\n');
    const { filesLine, testsLine } = parseAggregateLines(raw);
    expect(filesLine).toBe('Test Files  92 passed (92)');
    expect(testsLine).toBe('Tests  1542 passed (1542)');
  });

  it('集計行が無ければ両方 null（判定できない、の材料）', () => {
    const raw = 'write EPIPE\nsomething crashed before any summary';
    expect(parseAggregateLines(raw)).toEqual({ filesLine: null, testsLine: null });
  });

  it('passed の件数を読む', () => {
    expect(parsePassedCount('Tests  1542 passed (1542)')).toBe(1542);
  });

  it('failed が混ざっていても passed の数だけを読む', () => {
    expect(parsePassedCount('Tests  2 failed | 10 passed (12)')).toBe(10);
  });

  it('"passed" という語が無ければ 0（Issue #311 の実測そのもの: 1 skipped (1)）', () => {
    expect(parsePassedCount('Tests  1 skipped (1)')).toBe(0);
  });

  it('testsLine が null なら 0', () => {
    expect(parsePassedCount(null)).toBe(0);
  });
});

describe('judgeExecution（歯A: 実行の側）', () => {
  it('passed > 0 なら ok', () => {
    const raw = ' Test Files  3 passed (3)\n      Tests  10 passed (10)';
    const result = judgeExecution(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.passed).toBe(10);
    }
  });

  it('全部飛ばされて passed が0（Issue #311 の症状そのもの）なら exit 1 系（EXIT_ZERO_PASSED）', () => {
    const raw = ' Test Files  1 skipped (1)\n      Tests  1 skipped (1)';
    const result = judgeExecution(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_ZERO_PASSED);
      expect(result.message).toContain('実行の側');
    }
  });

  it('集計行そのものが出ていなければ「判定できない」（EXIT_UNKNOWN）— EXIT_ZERO_PASSED とは別の exit code', () => {
    const raw = 'write EPIPE\nfork pool crashed';
    const result = judgeExecution(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_UNKNOWN);
      expect(result.exitCode).not.toBe(EXIT_ZERO_PASSED);
      expect(result.message).toContain('判定できない');
    }
  });
});

describe('findUnconditionalSkips（歯B: ソースの側）', () => {
  it('describe.skip を検出し、file/line/matched を返す', () => {
    const content = [
      "import { describe, it, expect } from 'vitest';",
      '',
      `describe${dotSkip()}('全部飛ばす', () => {`,
      "  it('本来なら落ちる', () => { expect(1).toBe(2); });",
      '});',
    ].join('\n');
    const hits = findUnconditionalSkips([{ path: 'packages/core/src/x.test.ts', content }]);
    expect(hits).toEqual([
      { path: 'packages/core/src/x.test.ts', line: 3, matched: `describe${dotSkip()}` },
    ]);
  });

  it('it.skip / test.skip も検出する', () => {
    const content = [
      `it${dotSkip()}('a', () => {});`,
      `test${dotSkip()}('b', () => {});`,
    ].join('\n');
    const hits = findUnconditionalSkips([{ path: 'f.test.ts', content }]);
    expect(hits.map((h) => h.matched)).toEqual([`it${dotSkip()}`, `test${dotSkip()}`]);
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });

  it('.skip.each のような派生も検出する', () => {
    const content = `describe${dotSkip(true)}([1, 2])('%s', () => {});`;
    const hits = findUnconditionalSkips([{ path: 'f.test.ts', content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].matched).toBe(`describe${dotSkip(true)}`);
  });

  it('条件付き skipIf は対象外（1件も検出しない）', () => {
    const skipIf = '.' + 'skipIf';
    const content = [
      `it${skipIf}(process.env.CI)('a', () => {});`,
      `describe${skipIf}(true)('b', () => {});`,
    ].join('\n');
    expect(findUnconditionalSkips([{ path: 'f.test.ts', content }])).toEqual([]);
  });

  it('runIf も対象外', () => {
    const runIf = '.' + 'runIf';
    const content = `it${runIf}(false)('a', () => {});`;
    expect(findUnconditionalSkips([{ path: 'f.test.ts', content }])).toEqual([]);
  });

  it('実行時の ctx.skip() は対象外（describe/it/test 以外のオブジェクトへの .skip）', () => {
    const content = ['it(\'a\', (ctx) => {', `  ctx${dotSkip()}();`, '});'].join('\n');
    expect(findUnconditionalSkips([{ path: 'f.test.ts', content }])).toEqual([]);
  });

  it('複数ファイル・複数箇所をまとめて拾える', () => {
    const a = `it${dotSkip()}('a', () => {});`;
    const b = [`describe${dotSkip()}('b', () => {`, `  it${dotSkip()}('c', () => {});`, '});'].join(
      '\n',
    );
    const hits = findUnconditionalSkips([
      { path: 'a.test.ts', content: a },
      { path: 'b.test.ts', content: b },
    ]);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts', 'b.test.ts', 'b.test.ts']);
  });

  it('スキップが無ければ空配列', () => {
    const content = "it('a', () => { expect(1).toBe(1); });";
    expect(findUnconditionalSkips([{ path: 'f.test.ts', content }])).toEqual([]);
  });
});

describe('formatSkipGuardMessage', () => {
  it('file:line・見つかった形・次の手を含む', () => {
    const msg = formatSkipGuardMessage([
      { path: 'packages/core/src/x.test.ts', line: 3, matched: `describe${dotSkip()}` },
    ]);
    expect(msg).toContain('packages/core/src/x.test.ts:3');
    expect(msg).toContain(`describe${dotSkip()}`);
    expect(msg).toContain('skipIf');
    expect(msg).toContain('Issue');
  });
});

describe('リポジトリ自身との突き合わせ（回帰）', () => {
  it('root の vitest.config.ts から include を読める', async () => {
    const globs = await readIncludeGlobs(ROOT);
    expect(Array.isArray(globs)).toBe(true);
    expect(globs.length).toBeGreaterThan(0);
  });

  it('include に一致するテストファイルが実在する（少なくとも自分自身を含む）', async () => {
    const globs = await readIncludeGlobs(ROOT);
    const matched = collectMatchingTestFiles(ROOT, globs);
    expect(matched).toContain('scripts/test-guard-core.test.ts');
  });
});

/**
 * `judgeStaticSkipScan`（歯Bの最終判定・3値）。
 *
 * **マネージャーの追加の枷（依頼者経由。#311 実装中）**: 「歯Bの走査が0ファイル
 * だったとき、それは『合格』ではなく『判定できない』であること」——
 * `grep -c` が返す 0 と同じ形（`AGENTS.md`「静かに失敗する道具」）で、
 * 「無条件の skip が0件だった」（見て、無かった）と「走査対象が0件だった」
 * （見ていない）を混ぜないことを固定する。
 */
describe('judgeStaticSkipScan（歯B: 0ファイル/検出/合格の3値）', () => {
  it('matchedPaths が0件なら「判定できない」（EXIT_SCAN_EMPTY）— hits の中身に関係なく', () => {
    const result = judgeStaticSkipScan([], []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_SCAN_EMPTY);
      expect(result.exitCode).not.toBe(EXIT_STATIC_SKIP);
      expect(result.exitCode).not.toBe(EXIT_UNKNOWN);
      expect(result.message).toContain('判定できない');
    }
  });

  it('matchedPaths が1件以上あり hits が空なら合格', () => {
    const result = judgeStaticSkipScan(['a.test.ts'], []);
    expect(result.ok).toBe(true);
  });

  it('matchedPaths が1件以上あり hits があれば EXIT_STATIC_SKIP（EXIT_SCAN_EMPTY ではない）', () => {
    const result = judgeStaticSkipScan(
      ['a.test.ts'],
      [{ path: 'a.test.ts', line: 1, matched: `describe${dotSkip()}` }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_STATIC_SKIP);
      expect(result.exitCode).not.toBe(EXIT_SCAN_EMPTY);
    }
  });
});

describe('runStaticSkipGuard（I/O込みの合成。実リポジトリに対して回す）', () => {
  it('実在の ROOT に対して回すと合格になる（このブランチのソースに無条件skipは無い前提）', async () => {
    const result = await runStaticSkipGuard(ROOT);
    expect(result.ok).toBe(true);
  });

  it('存在しないルートを渡すと「判定できない」に倒れる（0ファイル、EXIT_SCAN_EMPTY）', async () => {
    // vitest.config.ts の import 自体が失敗する（存在しないパス）。
    // 例外を握り潰さず、EXIT_SCAN_EMPTY として同じ「判定できない」へ倒すことを確かめる。
    const result = await runStaticSkipGuard('/nonexistent-root-for-test-guard-core-test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_SCAN_EMPTY);
    }
  });
});
