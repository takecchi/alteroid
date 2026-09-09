import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
import {
  EXIT_OBSERVATION_DUE,
  EXIT_OBSERVATION_UNDECLARED,
  EXIT_SCAN_EMPTY,
  EXIT_STATIC_SKIP,
  EXIT_UNKNOWN,
  EXIT_ZERO_PASSED,
  ROOT,
  collectMatchingTestFiles,
  findObservationDebts,
  findUnconditionalSkips,
  formatObservationGuardMessage,
  formatSkipGuardMessage,
  isObservationFile,
  judgeExecution,
  judgeObservationScan,
  judgeStaticSkipScan,
  parseAggregateLines,
  parsePassedCount,
  readIncludeGlobs,
  readObservationDeclaration,
  runObservationGuard,
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

const BACKTICK = '`';

/** `.foo.bar` のような修飾子の連鎖をソースへ焼き込まないための組み立てヘルパ。
 * `chainSuffix('concurrent', 'skip')` → `'.concurrent.skip'`。 */
function chainSuffix(...segments: string[]): string {
  return segments.map((s) => '.' + s).join('');
}

/** `.skip` を1トークンとしてソースに焼き込まないための組み立てヘルパ（後方互換の別名）。 */
function dotSkip(each = false) {
  return chainSuffix('skip', ...(each ? ['each'] : []));
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

  /**
   * CI で実際に踏んだ欠陥の回帰（GitHub Actions run 32665717865、head sha
   * `d26f5a4`）。vitest が ANSI エスケープでラベルを色付けして出す形
   * （ローカルではパイプ経由なので出ないが、GitHub Actions のログでは出る）。
   * `^\s*Test Files` がエスケープシーケンスを空白として読めず、緑のまま
   * 走り切ったのに「判定できない」（`EXIT_UNKNOWN`）に誤って倒れていた。
   * 断片は実際の CI ログから採ったもの（`\x1b[2m` 等）。
   */
  it('ANSI エスケープで色付けされた集計行も読める（CI での実測回帰）', () => {
    const ESC = '\x1b';
    const raw = [
      `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m130 passed${ESC}[39m${ESC}[22m${ESC}[90m (130)${ESC}[39m`,
      `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m2493 passed${ESC}[39m${ESC}[22m${ESC}[90m (2493)${ESC}[39m`,
    ].join('\n');
    const { filesLine, testsLine } = parseAggregateLines(raw);
    expect(filesLine).not.toBeNull();
    expect(testsLine).not.toBeNull();
    expect(filesLine).toContain('Test Files');
    expect(filesLine).toContain('130 passed');
    expect(testsLine).toContain('Tests');
    expect(testsLine).toContain('2493 passed');
    const judged = judgeExecution(raw);
    expect(judged.ok).toBe(true);
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
    const content = [`it${dotSkip()}('a', () => {});`, `test${dotSkip()}('b', () => {});`].join(
      '\n',
    );
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
    const content = ["it('a', (ctx) => {", `  ctx${dotSkip()}();`, '});'].join('\n');
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

/**
 * マネージャーの差し戻し（2026-08-23。#311 実装中）: 旧実装の正規表現
 * （識別子の直後に `skip` が続き、その直後は追加の1修飾子と丸括弧の開きしか
 * 許さない形）を直接抜き出して13ケースへ掛けた実測で、3件を取りこぼして
 * いることが分かった。
 *
 * **注意（この段落自体が一度この穴を踏んだ）**: 以下で取りこぼしの形を説明する
 * とき、`it` や `describe` の直後へ実際の呼び出し構文（`.skip` と丸括弧・
 * バッククォートの組み合わせ）をそのまま書くと、歯Bの本番スキャンがこの
 * ファイル自身を「無条件の静的 skip」として検出してしまう。だから
 * 識別子と修飾子のあいだへ意図して半角スペースを挟み、地の文として読める形
 * にしてある（`SKIP_CALL_CHAIN_RE` は識別子の直後に空白を挟むと連鎖を
 * 拾わない——「意図して直さないもの」の doc と同じ性質を、ここでは説明の
 * ために逆手に取っている）。
 *
 * 取りこぼしていた3形:
 *
 * 1. `it` .skip.each の直後を丸括弧ではなくバッククォートで始める
 *    tagged template 形（vitest 標準の書き方。旧実装は呼び出しの開きが
 *    丸括弧であることしか許していなかった）。**この repo に実在するか、
 *    ここで訂正しておく**: `grep -rnoE` で `each` の直後がバッククォートか
 *    丸括弧かを横断的に見た初回の実測は「実在する」と読んだが、ヒットの中身
 *    （`packages/core/src/tools.test.ts` / `railway/setup.test.ts` の該当行）を
 *    1件ずつ確認し直すと、**すべて Markdown のコードスパンとして地の文へ
 *    `` `it` .each ``（バッククォートで閉じただけ）と書いた散文であり、
 *    タグ付きテンプレートの実コードは1件も無かった**——この repo の `.each` は
 *    いまのところ全部が丸括弧＋配列の形（`it.each(scripts)` 等）である。
 *    つまり `grep -c` と同じ「見ているのに探し方の側で取りこぼす」形の逆
 *    （ここでは「当たっているのに中身が違う」形）を、この doc を書く過程で
 *    自分で踏んだ。**それでもタグ付きテンプレート形は vitest 標準の構文
 *    であり、次に書かれたときに歯Bが見逃してよい理由にはならない**ので、
 *    直す判断そのものは変えていない
 * 2. `it` .concurrent.skip のように、修飾子が `skip` の**前**に来る形
 *    （旧実装は describe/it/test の直後に skip が直接続くことしか
 *    許していなかった）。この repo にいま `concurrent` 修飾子の実例は0件だが、
 *    歯Bが「無条件の静的 skip はソースに残らない」と名乗る判別器である以上、
 *    次に書かれたときに緑のまま素通りさせない
 *
 * **13ケース全部をここに固定する。当てる側だけでなく当てない側も。**
 * 当てる側だけ足すと、「全部に当てる」実装（＝判別器として無価値）でも
 * 緑になってしまう。
 */
describe('findUnconditionalSkips（歯B: マネージャー実測の13ケース。#311 差し戻し）', () => {
  const cases: Array<{ label: string; want: boolean; build: () => string }> = [
    // ── 当てる側（8ケース） ──────────────────────────────────────────
    {
      label: 'describe.skip（基本形）',
      want: true,
      build: () => `describe${chainSuffix('skip')}('a', () => {});`,
    },
    {
      label: 'it.skip（基本形）',
      want: true,
      build: () => `it${chainSuffix('skip')}('a', () => {});`,
    },
    {
      label: 'test.skip（基本形）',
      want: true,
      build: () => `test${chainSuffix('skip')}('a', () => {});`,
    },
    {
      label: 'it.skip.each（配列形。旧実装でも当たっていた）',
      want: true,
      build: () => `it${chainSuffix('skip', 'each')}([1, 2])('a', () => {});`,
    },
    {
      label:
        'it.skip.each（tagged template 形。旧実装が取りこぼしていた1件目。開きが `(` ではなく バッククォート）',
      want: true,
      build: () =>
        `it${chainSuffix('skip', 'each')}${BACKTICK}\na | b\n${BACKTICK}('x', () => {});`,
    },
    {
      label: 'describe.skip.each（tagged template 形。取りこぼしていた2件目）',
      want: true,
      build: () =>
        `describe${chainSuffix('skip', 'each')}${BACKTICK}tbl${BACKTICK}('x', () => {});`,
    },
    {
      label:
        'it.concurrent.skip（修飾子が skip の前に来る形。取りこぼしていた3件目。この repo に .concurrent の実例は0件だが、次に書かれたら緑のまま素通りさせない）',
      want: true,
      build: () => `it${chainSuffix('concurrent', 'skip')}('a', () => {});`,
    },
    {
      label: 'it.skip.concurrent（修飾子が skip の後に来る形。旧実装でも当たっていた）',
      want: true,
      build: () => `it${chainSuffix('skip', 'concurrent')}('a', () => {});`,
    },
    // ── 当てない側（4ケース） ────────────────────────────────────────
    {
      label: 'it.skipIf(cond)（条件付き。対象外——skipIf は文字列として skip と一致しない）',
      want: false,
      build: () => `it${chainSuffix('skipIf')}(cond)('a', () => {});`,
    },
    {
      label: 'describe.skipIf(true)（条件付き。対象外）',
      want: false,
      build: () => `describe${chainSuffix('skipIf')}(true)('b', () => {});`,
    },
    {
      label: 'it.runIf(cond)（条件付き。対象外）',
      want: false,
      build: () => `it${chainSuffix('runIf')}(cond)('a', () => {});`,
    },
    {
      label: 'ctx.skip()（実行時。describe/it/test 以外への .skip なので対象外）',
      want: false,
      build: () => `ctx${chainSuffix('skip')}();`,
    },
    // ── 意図して当てない側（1ケース） ──────────────────────────────
    {
      label:
        'it .skip(（識別子と .skip のあいだに空白。意図して当てない — この repo は prettier を通すのでこの形は出ない。format:check が守る）',
      want: false,
      build: () => `it ${chainSuffix('skip')}('a');`,
    },
  ];

  it.each(cases)('$label → want=$want', ({ want, build }) => {
    const hits = findUnconditionalSkips([{ path: 'f.test.ts', content: build() }]);
    expect(hits.length > 0).toBe(want);
  });

  it('13ケースの内訳が想定どおり（当てる8・当てない4・意図して当てない1）', () => {
    expect(cases).toHaveLength(13);
    expect(cases.filter((c) => c.want).length).toBe(8);
    expect(cases.filter((c) => !c.want).length).toBe(5);
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

/**
 * 歯C（Issue #396）: 観測用テストに終了条件と見直し期限を書かせ、期限を
 * 過ぎたら赤くする。**今日の日付は 2026-08-27**（依頼時点）——ここで使う
 * 「未来の期限」はすべてこれより後にしてある。
 */
describe('isObservationFile（歯C: 名乗りの判定）', () => {
  it('名乗っていない普通のテストファイルは対象外（散文の「観測」を書いても素通り）', () => {
    const content = [
      '// これは観測記録である。書き捨てのテストではない。',
      '// 終了条件: 直したら消す',
      '// 見直し期限: 2020-01-01',
    ].join('\n');
    expect(isObservationFile('normal.test.ts', content)).toBe(false);
  });

  it('.observed. を含むパスは対象になる（孤児ブランチの実例そのもの）', () => {
    expect(isObservationFile('packages/core/src/inbox-delivery.observed.test.ts', '')).toBe(true);
  });

  it('-scratch. を含むパスは対象になる（生きている枝の実例そのもの）', () => {
    expect(isObservationFile('apps/web/app/routes/chat.issue388-scratch.test.tsx', '')).toBe(true);
  });

  it('.scratch. を含むパスも対象になる', () => {
    expect(isObservationFile('packages/core/src/x.scratch.test.ts', '')).toBe(true);
  });

  it('冒頭コメント領域の @観測 は対象になる', () => {
    const content = [
      '// @観測',
      '// 終了条件: 直したら消す',
      '// 見直し期限: 2099-01-01',
      "import { it } from 'vitest';",
    ].join('\n');
    expect(isObservationFile('normal.test.ts', content)).toBe(true);
  });

  it('冒頭のコメント領域より後ろに書かれた @観測 は対象にならない', () => {
    const content = [
      '// 普通のコメント',
      "import { it } from 'vitest';",
      '// @観測 ← ここはコメント領域の外',
    ].join('\n');
    expect(isObservationFile('normal.test.ts', content)).toBe(false);
  });
});

describe('readObservationDeclaration（歯C: 2項目を読む）', () => {
  it('終了条件・見直し期限が両方揃っていれば両方読める', () => {
    const content = [
      '/**',
      ' * @観測',
      ' * 終了条件: 直したらこの記録を「基準」に書き換えるか捨てる',
      ' * 見直し期限: 2099-01-01',
      ' */',
      "import { it } from 'vitest';",
    ].join('\n');
    expect(readObservationDeclaration(content)).toEqual({
      終了条件: '直したらこの記録を「基準」に書き換えるか捨てる',
      見直し期限: '2099-01-01',
      見直し期限Raw: '2099-01-01',
    });
  });

  it('全角コロンでも読める', () => {
    const content = ['// 終了条件：直したら消す', '// 見直し期限：2099-01-01'].join('\n');
    const decl = readObservationDeclaration(content);
    expect(decl.終了条件).toBe('直したら消す');
    expect(decl.見直し期限).toBe('2099-01-01');
  });

  it('終了条件が無ければ undefined', () => {
    const content = '// 見直し期限: 2099-01-01';
    expect(readObservationDeclaration(content).終了条件).toBeUndefined();
  });

  it('見直し期限が無ければ undefined（見直し期限Raw も undefined）', () => {
    const content = '// 終了条件: 直したら消す';
    const decl = readObservationDeclaration(content);
    expect(decl.見直し期限).toBeUndefined();
    expect(decl.見直し期限Raw).toBeUndefined();
  });

  it('見直し期限の書式が壊れている（ゼロ埋め無し）と 見直し期限 は undefined だが 見直し期限Raw には生の値が残る', () => {
    const content = ['// 終了条件: 直したら消す', '// 見直し期限: 2026-9-1'].join('\n');
    const decl = readObservationDeclaration(content);
    expect(decl.見直し期限).toBeUndefined();
    expect(decl.見直し期限Raw).toBe('2026-9-1');
  });
});

describe('findObservationDebts / judgeObservationScan（歯C: 3状態）', () => {
  it('名乗っていない普通のファイルは、2項目が無くても負債にならない（何を書いてあっても素通り）', () => {
    const content = '// 何も申告していない、ただのテストファイル。';
    const debts = findObservationDebts([{ path: 'normal.test.ts', content }], '2026-08-27');
    expect(debts).toEqual([]);
  });

  it('2項目が揃っていて期限が未来なら負債にならない', () => {
    const content = ['// @観測', '// 終了条件: 直したら消す', '// 見直し期限: 2099-01-01'].join(
      '\n',
    );
    const debts = findObservationDebts([{ path: 'x.observed.test.ts', content }], '2026-08-27');
    expect(debts).toEqual([]);
  });

  it('終了条件が無ければ EXIT_OBSERVATION_UNDECLARED（judgeObservationScan 経由）', () => {
    const content = ['// @観測', '// 見直し期限: 2099-01-01'].join('\n');
    const debts = findObservationDebts([{ path: 'x.observed.test.ts', content }], '2026-08-27');
    expect(debts).toHaveLength(1);
    expect(debts[0].kind).toBe('undeclared');
    const judged = judgeObservationScan(['x.observed.test.ts'], debts);
    expect(judged.ok).toBe(false);
    if (!judged.ok) {
      expect(judged.exitCode).toBe(EXIT_OBSERVATION_UNDECLARED);
    }
  });

  it('見直し期限が無ければ EXIT_OBSERVATION_UNDECLARED', () => {
    const content = ['// @観測', '// 終了条件: 直したら消す'].join('\n');
    const debts = findObservationDebts([{ path: 'x.observed.test.ts', content }], '2026-08-27');
    const judged = judgeObservationScan(['x.observed.test.ts'], debts);
    expect(judged.ok).toBe(false);
    if (!judged.ok) expect(judged.exitCode).toBe(EXIT_OBSERVATION_UNDECLARED);
  });

  it('見直し期限の書式が壊れていれば EXIT_OBSERVATION_UNDECLARED（2026-9-1 のような書式）', () => {
    const content = ['// @観測', '// 終了条件: 直したら消す', '// 見直し期限: 2026-9-1'].join('\n');
    const debts = findObservationDebts([{ path: 'x.observed.test.ts', content }], '2026-08-27');
    const judged = judgeObservationScan(['x.observed.test.ts'], debts);
    expect(judged.ok).toBe(false);
    if (!judged.ok) expect(judged.exitCode).toBe(EXIT_OBSERVATION_UNDECLARED);
  });

  it('見直し期限が当日なら、まだ合格（> であって >= ではない）', () => {
    const content = ['// @観測', '// 終了条件: 直したら消す', '// 見直し期限: 2026-08-27'].join(
      '\n',
    );
    const debts = findObservationDebts([{ path: 'x.observed.test.ts', content }], '2026-08-27');
    expect(debts).toEqual([]);
    const judged = judgeObservationScan(['x.observed.test.ts'], debts);
    expect(judged.ok).toBe(true);
  });

  it('見直し期限の翌日なら EXIT_OBSERVATION_DUE（到達を見る番が来た）', () => {
    const content = ['// @観測', '// 終了条件: 直したら消す', '// 見直し期限: 2026-08-27'].join(
      '\n',
    );
    const debts = findObservationDebts([{ path: 'x.observed.test.ts', content }], '2026-08-28');
    expect(debts).toHaveLength(1);
    expect(debts[0].kind).toBe('due');
    const judged = judgeObservationScan(['x.observed.test.ts'], debts);
    expect(judged.ok).toBe(false);
    if (!judged.ok) {
      expect(judged.exitCode).toBe(EXIT_OBSERVATION_DUE);
      expect(judged.exitCode).not.toBe(EXIT_OBSERVATION_UNDECLARED);
    }
  });

  it('matchedPaths が0件なら EXIT_SCAN_EMPTY（judgeObservationScan を直接呼ぶ。debts の中身に関係なく）', () => {
    const judged = judgeObservationScan([], []);
    expect(judged.ok).toBe(false);
    if (!judged.ok) {
      expect(judged.exitCode).toBe(EXIT_SCAN_EMPTY);
      expect(judged.exitCode).not.toBe(EXIT_OBSERVATION_UNDECLARED);
      expect(judged.exitCode).not.toBe(EXIT_OBSERVATION_DUE);
    }
  });
});

describe('formatObservationGuardMessage', () => {
  it('undeclared: file:line・次の手（2項目を書くこと）を含む', () => {
    const msg = formatObservationGuardMessage(
      [{ path: 'x.observed.test.ts', line: 2, detail: '終了条件が無い' }],
      'undeclared',
    );
    expect(msg).toContain('x.observed.test.ts:2');
    expect(msg).toContain('終了条件');
    expect(msg).toContain('見直し期限');
    expect(msg).toContain('.claude/skills/observation-tests/SKILL.md');
  });

  it('due: file:line・3つの次の手（基準へ書き換える／捨てる／延ばす）を含む', () => {
    const msg = formatObservationGuardMessage(
      [{ path: 'x.observed.test.ts', line: 3, detail: '終了条件: a / 見直し期限: 2026-08-27' }],
      'due',
    );
    expect(msg).toContain('x.observed.test.ts:3');
    expect(msg).toContain('基準');
    expect(msg).toContain('捨てる');
    expect(msg).toContain('延ばす');
    expect(msg).toContain('.claude/skills/observation-tests/SKILL.md');
  });
});

describe('runObservationGuard（I/O込みの合成。実リポジトリに対して回す）', () => {
  it('実在の ROOT に対して回すと合格になる（main に観測用テストが無い前提。#396 要件6の確認そのもの）', async () => {
    const result = await runObservationGuard(ROOT, '2026-08-27');
    expect(result.ok).toBe(true);
  });

  it('存在しないルートを渡すと「判定できない」に倒れる（0ファイル、EXIT_SCAN_EMPTY）', async () => {
    const result = await runObservationGuard(
      '/nonexistent-root-for-test-guard-core-test',
      '2026-08-27',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_SCAN_EMPTY);
    }
  });

  it('today を渡さなければ既定値（現在時刻）で回る——例外を投げず、実在の ROOT で合格になる', async () => {
    const result = await runObservationGuard(ROOT);
    expect(result.ok).toBe(true);
  });
});

/**
 * **`test-guard-core.mjs` の「最初の1件を返す」実装が安全である前提そのものの歯（PR 本文参照）。**
 *
 * `parseAggregateLines`（このファイルの直上）は `.match(/…/m)`（`/g` 無し）で
 * **最初の集計ブロックしか読まない。** #742・#745 の測定は、それが「いまの HEAD の
 * 構造では複数ブロックが届かないから安全」だと固定した——根拠の7本は
 * `scripts/mutate-core-strip-ansi.test.ts` に逐語で在る（`潰した経路は7本` で当たる）。
 *
 * **その7本のうち経路3は「`scripts/test.mjs` は vitest の起動をループの外に1回だけ
 * 書いている」という、この関数の唯一の入力源についての事実である。** 到達不能を
 * 「測って確かめたので歯を置かない」理由にするなら、**その前提そのものを歯にする**
 * ——誰かが2本目の vitest 起動を足した瞬間、あるいは起こし方の形が変わって
 * 「1本しか無い」ことそのものが数えられなくなった瞬間に、ここが赤くなるようにする。
 *
 * ## 逐語一致ではなく「件数」で測る
 *
 * `grep -Fn -- "spawn('vitest'"` のような逐語一致は**変更検知器**になる——
 * 引用符の種類（`'vitest'` / `"vitest"`）や空白・改行の入れ方が1文字変わっただけで
 * 赤くなる。ふるまいが1文字も変わっていないのに落ちる歯はこの repo が嫌う形である
 * （`AGENTS.md`「テストを弱めずに直す」）。だから**「vitest を子プロセスとして
 * 起こす箇所の件数」**を測る。正規表現は `spawn` だけでなく `execFile` /
 * `execFileSync` / `exec` / `execSync` / `spawnSync` も拾う——`spawn` を
 * `execFile` へ書き換えて2本目を足す、という抜け道を塞ぐためである。
 *
 * ## `>= 1` ではなく `=== 1` で撃つ
 *
 * 2本目が足された（件数が2になった）ときだけでなく、**起こし方の形が根本的に
 * 変わって、この正規表現では1本も数えられなくなった（件数が0になった）**ときも
 * 赤くしたい。後者は「vitest を1回しか起こさない」という前提が壊れたのではなく、
 * **この歯の観測手段そのものが壊れた**——どちらも「到達可能性を測り直すべき合図」
 * である点は同じなので、`>= 1` ではなく `=== 1` で両方を撃つ。
 *
 * ## 実物のソースを読む（フィクスチャを持たない）
 *
 * `scripts/test.mjs` をディスクから直接 `readFileSync` する。フィクスチャ文字列を
 * 持つと、実物がどう変わってもこの歯は緑のままになり——存在意義が消える。
 * パスはこのテストファイルからの相対（`import.meta.dirname` 経由）で解決する
 * （`scripts/check-sdk-quotes.test.ts` の `実物の検査` describe と同じ形。あちらは
 * インストール済みの `sdk.d.ts` を実物として読み、フィクスチャは合成テストの側にだけ
 * 持つ——この歯も同じ分担にした）。
 */
describe('scripts/test.mjs は vitest を1回しか起こさない（test-guard-core.mjs の「最初の1件」実装が安全である前提そのものの歯）', () => {
  const TEST_MJS_PATH = join(import.meta.dirname, 'test.mjs');
  const testMjsSource = readFileSync(TEST_MJS_PATH, 'utf8');

  // spawn / execFile 系のどの形で vitest を起こしても拾う。
  //
  // 訂正（自分で実測して確認した。node -e で以下を走らせた）:
  //   const bad  = /(exec|execSync|execFile|execFileSync)\(\s*['"]vitest['"]/g;
  //   const good = /(spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"]vitest['"]/g;
  //   'execFileSync(\'vitest\''.match(bad)   // → ["execFileSync('vitest'"]（当たる）
  //   'execFileSync(\'vitest\''.match(good)  // → ["execFileSync('vitest'"]（同じ）
  // 選択肢の順序は結果に効かない——JS の正規表現は選択肢の中でバックトラック
  // するため、`exec` を先に置いても `\(` の直前で外れた時点で同じ開始位置の
  // 次の選択肢（`execFileSync` 等）を試し、結局は最長一致にたどり着く。
  // それでも長い名前を先に書いているのは、読む人が上から読んで「どれに
  // 当たるか」を追いやすくするためであって、正しさの条件ではない。
  const VITEST_CHILD_PROCESS_INVOCATION =
    /(spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"]vitest['"]/g;

  it('実物の scripts/test.mjs を読めている（空文字列や別ファイルを掴んでいない）', () => {
    // パスを間違えて空文字列を読んでいても件数0で下のテストが赤くなるので致命的では
    // ないが、「なぜ赤いか」が読めるよう、実物にしか無い印を別立てで確認しておく。
    expect(testMjsSource.length).toBeGreaterThan(0);
    expect(testMjsSource).toContain('function runVitest');
  });

  it('vitest を子プロセスとして起こす箇所の件数はちょうど 1 である（>= 1 ではない）', () => {
    const matches = testMjsSource.match(VITEST_CHILD_PROCESS_INVOCATION) ?? [];

    const message = [
      '`scripts/test-guard-core.mjs` の `parseAggregateLines` は最初の集計ブロックしか',
      '読まない。それが安全なのは、この関数の唯一の入力源である `scripts/test.mjs` が',
      'vitest を1回しか起こさないからである。',
      '',
      'この歯が落ちたら、歯の数字（下の `toBe(1)`）を直す前に、',
      '`scripts/mutate-core-strip-ansi.test.ts` に記録されている7経路を当たり直して、',
      '複数ブロックが `test-guard-core.mjs` へ届くようになっていないかを測ること',
      "（`command grep -Fn -- '潰した経路は7本' scripts/mutate-core-strip-ansi.test.ts`",
      'で当たる）。届くようになっていたら、直す番なのは `test-guard-core.mjs` の側である。',
      '',
      `実測: \`scripts/test.mjs\` の中で vitest を子プロセスとして起こしている箇所 = ${matches.length} 件`,
      `（一致した文字列: ${JSON.stringify(matches)}）`,
    ].join('\n');

    expect(matches.length, message).toBe(1);
  });
});
