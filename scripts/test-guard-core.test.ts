import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import {
  EXIT_BAD_DEADLINE,
  EXIT_OBSERVATION_DUE,
  EXIT_OBSERVATION_UNDECLARED,
  EXIT_SCAN_EMPTY,
  EXIT_SCOPE_VIOLATION,
  EXIT_STATIC_SKIP,
  EXIT_UNKNOWN,
  EXIT_ZERO_PASSED,
  ROOT,
  collectMatchingTestFiles,
  dropBareDashDash,
  extractDeadlineSeconds,
  extractScope,
  findObservationDebts,
  findUnconditionalSkips,
  formatDeadlineMessage,
  formatObservationGuardMessage,
  formatSkipGuardMessage,
  hasReporterFlag,
  isObservationFile,
  judgeExecution,
  judgeObservationScan,
  judgeStaticSkipScan,
  loadVitestFlagInfo,
  matchScopedPositionals,
  parseAggregateLines,
  parsePassedCount,
  readIncludeGlobs,
  readObservationDeclaration,
  resolveReporterArgs,
  resolveScopedArgs,
  runObservationGuard,
  runStaticSkipGuard,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
} from './test-guard-core.mjs';

// フィクスチャの `skip` 呼び出しは文字列連結で組み立てる（`dotSkip`）: このファイル自身が歯Bの本番スキャンの対象で、連続した文字列を書くと `pnpm test` が恒久的に赤くなるため。

const BACKTICK = '`';

function chainSuffix(...segments: string[]): string {
  return segments.map((s) => '.' + s).join('');
}

function dotSkip(each = false) {
  return chainSuffix('skip', ...(each ? ['each'] : []));
}

describe('dropBareDashDash（pnpm 経由の素の `--` を vitest へ渡す前に落とす）', () => {
  it('陽性: 先頭の `--` を落とす（pnpm が付けてくる形そのもの）', () => {
    expect(dropBareDashDash(['--', '--maxWorkers=4', 'a.test.ts'])).toEqual([
      '--maxWorkers=4',
      'a.test.ts',
    ]);
  });

  it('やりすぎの対照: `--` を含まない引数は1つも変えない（option 付き）', () => {
    const argv = ['--maxWorkers=4', 'a.test.ts'];
    expect(dropBareDashDash(argv)).toEqual(argv);
  });

  it('やりすぎの対照: `--` を含まない引数は1つも変えない（reporter option だけ）', () => {
    const argv = ['--reporter=verbose'];
    expect(dropBareDashDash(argv)).toEqual(argv);
  });

  it('やりすぎの対照: 引数が空なら空のまま', () => {
    expect(dropBareDashDash([])).toEqual([]);
  });

  it('やりすぎの対照: `--` で始まるが `--` そのものではない option は落とさない（`--maxWorkers` を握り潰さない）', () => {
    const argv = ['--maxWorkers', '4'];
    expect(dropBareDashDash(argv)).toEqual(argv);
  });

  it('`--` が途中や複数回に現れても、素の `--` 要素だけを全部落とす（splitVerifyArgs と同じ規則）', () => {
    expect(dropBareDashDash(['a.test.ts', '--', '--bail', '--'])).toEqual(['a.test.ts', '--bail']);
  });
});

describe('extractScope', () => {
  it('--scope=<value> を取り出し、残りは順序を保って返す', () => {
    expect(extractScope(['--root=../..', '--scope=apps/cli/src', '--maxWorkers=4'])).toEqual({
      scope: 'apps/cli/src',
      rest: ['--root=../..', '--maxWorkers=4'],
    });
  });

  it('`--scope` が無ければ scope は undefined、rest は元のまま', () => {
    const argv = ['apps/cli/src/interrupt.test.ts', '--maxWorkers=4'];
    expect(extractScope(argv)).toEqual({ scope: undefined, rest: argv });
  });
});

describe('matchScopedPositionals（範囲の中で位置引数を部分一致で解決する。#1691）', () => {
  const cwd = '/repo/apps/cli';
  const repoRoot = '/repo';
  const scope = 'apps/cli/src';
  const filesInScope = [
    'apps/cli/src/interrupt.test.ts',
    'apps/cli/src/memory.test.ts',
    'apps/cli/src/appraisal-stats.test.ts',
  ];

  it('(a) 位置引数が無い ⟹ 範囲そのものが唯一のフィルタになる（filesInScope を見ない）', () => {
    const result = matchScopedPositionals(['--root=../..'], scope, {
      cwd,
      repoRoot,
      filesInScope: [],
    });
    expect(result).toEqual({ ok: true, args: ['--root=../..', scope] });
  });

  it('(b) パッケージのディレクトリからの相対パス（1ファイル）⟹ 部分一致でそのファイルだけに絞られる', () => {
    const result = matchScopedPositionals(['--root=../..', 'src/interrupt.test.ts'], scope, {
      cwd,
      repoRoot,
      filesInScope,
    });
    expect(result).toEqual({
      ok: true,
      args: ['--root=../..', 'apps/cli/src/interrupt.test.ts'],
    });
  });

  it('(b2) パスではない部分一致の1語（レビュー差し戻しの再現）⟹ 範囲の中で当たるファイルだけに絞られる', () => {
    const result = matchScopedPositionals(['--root=../..', 'interrupt'], scope, {
      cwd,
      repoRoot,
      filesInScope,
    });
    expect(result).toEqual({
      ok: true,
      args: ['--root=../..', 'apps/cli/src/interrupt.test.ts'],
    });
  });

  it('(c) 範囲の外（cwd の外）を明らかに指す位置引数 ⟹ 断る（「範囲外」の文言。EXIT_SCOPE_VIOLATION）', () => {
    const result = matchScopedPositionals(
      ['--root=../..', '../../packages/core/src/other.test.ts'],
      scope,
      { cwd, repoRoot, filesInScope },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/範囲外/);
    expect(result.message).toContain('packages/core/src/other.test.ts');
  });

  it('(c2) cwd の中だが、範囲に部分一致するテストが1本も無い ⟹ 断る（「範囲内に一致なし」。範囲外とは別の文言）', () => {
    const result = matchScopedPositionals(['--root=../..', 'zzz-nonexistent-pattern'], scope, {
      cwd,
      repoRoot,
      filesInScope,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/範囲内に一致なし/);
    expect(result.message).not.toMatch(/範囲外/);
  });

  it('(d) `--maxWorkers=4 <ファイル>` ⟹ 両方効く（フラグはそのまま、ファイルは部分一致で範囲内のパスへ直る）', () => {
    const result = matchScopedPositionals(
      ['--root=../..', '--maxWorkers=4', 'src/interrupt.test.ts'],
      scope,
      { cwd, repoRoot, filesInScope },
    );
    expect(result).toEqual({
      ok: true,
      args: ['--root=../..', '--maxWorkers=4', 'apps/cli/src/interrupt.test.ts'],
    });
  });

  it('(e) `-t <名前>`（空白区切りの値）は位置引数として範囲判定に持ち込まない', () => {
    const result = matchScopedPositionals(['--root=../..', '-t', 'ある名前'], scope, {
      cwd,
      repoRoot,
      filesInScope,
    });
    expect(result).toEqual({
      ok: true,
      args: ['--root=../..', '-t', 'ある名前', scope],
    });
  });

  it('複数一致するときは、一致した全ファイルへ展開する（1個の位置引数がN個になる）', () => {
    const result = matchScopedPositionals(['--root=../..', 'test.ts'], scope, {
      cwd,
      repoRoot,
      filesInScope,
    });
    expect(result).toEqual({
      ok: true,
      args: [
        '--root=../..',
        'apps/cli/src/appraisal-stats.test.ts',
        'apps/cli/src/interrupt.test.ts',
        'apps/cli/src/memory.test.ts',
      ],
    });
  });

  it('先頭の `./` は部分一致の邪魔にならないよう剥がす', () => {
    const result = matchScopedPositionals(['--root=../..', './src/interrupt.test.ts'], scope, {
      cwd,
      repoRoot,
      filesInScope,
    });
    expect(result).toEqual({
      ok: true,
      args: ['--root=../..', 'apps/cli/src/interrupt.test.ts'],
    });
  });
});

function makeScopeFixtureRoot(): string {
  const dir = makeTempDirSync('test-guard-scope-');
  mkdirSync(join(dir, 'pkg-a', 'src'), { recursive: true });
  mkdirSync(join(dir, 'pkg-b', 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'vitest.config.ts'),
    "export default { test: { include: ['**/*.test.ts'] } };\n",
  );
  writeFileSync(join(dir, 'pkg-a', 'src', 'foo.test.ts'), 'export {};\n');
  writeFileSync(join(dir, 'pkg-a', 'src', 'bar-widget.test.ts'), 'export {};\n');
  writeFileSync(join(dir, 'pkg-b', 'src', 'baz.test.ts'), 'export {};\n');
  return dir;
}

describe('resolveScopedArgs（I/O込みの合成。#1691 レビュー差し戻しの再現をfixtureで固定する）', () => {
  it('パスではない部分一致の1語 ⟹ 範囲の中で当たるファイルだけに絞られる', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(['--scope=pkg-a/src', 'widget'], {
      cwd,
      repoRoot: root,
    });
    expect(result).toEqual({ ok: true, args: ['pkg-a/src/bar-widget.test.ts'] });
  });

  it('パスの形（打った場所からの相対パス）も、今までどおり効く', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(['--scope=pkg-a/src', 'src/foo.test.ts'], {
      cwd,
      repoRoot: root,
    });
    expect(result).toEqual({ ok: true, args: ['pkg-a/src/foo.test.ts'] });
  });

  it('範囲の外（別パッケージ）にしか無い文字列 ⟹ 断る（範囲外へは漏れない。「範囲内に一致なし」）', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(['--scope=pkg-a/src', 'baz'], {
      cwd,
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/範囲内に一致なし/);
  });

  it('範囲の外を明らかに指すパス ⟹ 断る（「範囲外」）', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(['--scope=pkg-a/src', '../pkg-b/src/baz.test.ts'], {
      cwd,
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/範囲外/);
  });

  it('位置引数が無ければ範囲そのものがフィルタになる（ディスクを読まない経路）', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(['--scope=pkg-a/src'], { cwd, repoRoot: root });
    expect(result).toEqual({ ok: true, args: ['pkg-a/src'] });
  });

  it('`--scope` が無ければ何も変えない（root の `pnpm test <パスの一部>` はここを通らない。ディスクも読まない）', async () => {
    const argv = ['apps/cli/src/interrupt.test.ts', '--maxWorkers=4'];
    const result = await resolveScopedArgs(argv, { cwd: '/repo/apps/cli', repoRoot: '/repo' });
    expect(result).toEqual({ ok: true, args: argv });
  });
});

describe('resolveScopedArgs は --shard=1/3 / --reporter=dot（`=` 形）を位置引数と取り違えず素通しする', () => {
  it('位置引数が無いとき: --shard=1/3 --reporter=dot はそのまま残り、範囲が末尾へ足される（ディスクを読まない経路）', async () => {
    const result = await resolveScopedArgs(
      ['--scope=packages/storage-pg/src', '--shard=1/3', '--reporter=dot'],
      { cwd: '/repo/packages/storage-pg', repoRoot: '/repo' },
    );
    expect(result).toEqual({
      ok: true,
      args: ['--shard=1/3', '--reporter=dot', 'packages/storage-pg/src'],
    });
  });

  it('利用者の位置引数（部分一致のファイル名）と併用しても、--shard=1/3 --reporter=dot は素通しされる', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(
      ['--scope=pkg-a/src', '--shard=1/3', '--reporter=dot', 'widget'],
      { cwd, repoRoot: root },
    );
    expect(result).toEqual({
      ok: true,
      args: ['--shard=1/3', '--reporter=dot', 'pkg-a/src/bar-widget.test.ts'],
    });
  });
});

describe('--shard 1/3（空白区切り）は --scope と併用しても素通しされる（#2063 の続き。当初「断られる」だった歯を反転）', () => {
  it('`--shard` を `VALUE_TAKING_FLAGS` へ足した後: 位置引数が無いので範囲そのものがフィルタになり、`--shard 1/3` はそのまま残る（ディスクを読まない経路）', async () => {
    const result = await resolveScopedArgs(['--scope=pkg-a/src', '--shard', '1/3'], {
      cwd: '/repo/pkg-a',
      repoRoot: '/repo',
    });
    expect(result).toEqual({ ok: true, args: ['--shard', '1/3', 'pkg-a/src'] });
  });

  it('利用者の位置引数（部分一致のファイル名）と併用しても、`--shard 1/3`（空白区切り）は素通しされる', async () => {
    const root = makeScopeFixtureRoot();
    const cwd = join(root, 'pkg-a');
    const result = await resolveScopedArgs(['--scope=pkg-a/src', '--shard', '1/3', 'widget'], {
      cwd,
      repoRoot: root,
    });
    expect(result).toEqual({
      ok: true,
      args: ['--shard', '1/3', 'pkg-a/src/bar-widget.test.ts'],
    });
  });
});

describe('空白区切りで値を取る vitest のフラグは --scope と併用しても値を範囲に持ち込まない', () => {
  const VALUE_FLAGS: Array<[string, string]> = [
    ['--testTimeout', '5000'],
    ['--retry', '2'],
    ['--bail', '1'],
    ['--project', 'x'],
    ['--exclude', 'x'],
  ];

  it.each(VALUE_FLAGS)(
    '%s %s（空白区切り）: 位置引数が無ければ値はそのまま残り、範囲がフィルタになる',
    async (flag: string, value: string) => {
      const root = makeScopeFixtureRoot();
      const result = await resolveScopedArgs(['--scope=pkg-a/src', flag, value], {
        cwd: join(root, 'pkg-a'),
        repoRoot: root,
      });
      expect(result).toEqual({ ok: true, args: [flag, value, 'pkg-a/src'] });
    },
  );

  it.each(VALUE_FLAGS)(
    '%s %s（空白区切り）: 利用者の位置引数（widget）と併用しても、値は絞り込みに化けず widget だけが解決される',
    async (flag: string, value: string) => {
      const root = makeScopeFixtureRoot();
      const result = await resolveScopedArgs(['--scope=pkg-a/src', flag, value, 'widget'], {
        cwd: join(root, 'pkg-a'),
        repoRoot: root,
      });
      expect(result).toEqual({
        ok: true,
        args: [flag, value, 'pkg-a/src/bar-widget.test.ts'],
      });
    },
  );

  it.each(VALUE_FLAGS)('%s=%s（`=` 形）も同じに扱われる', async (flag: string, value: string) => {
    const root = makeScopeFixtureRoot();
    const eq = `${flag}=${value}`;
    const bare = await resolveScopedArgs(['--scope=pkg-a/src', eq], {
      cwd: join(root, 'pkg-a'),
      repoRoot: root,
    });
    expect(bare).toEqual({ ok: true, args: [eq, 'pkg-a/src'] });
    const withPositional = await resolveScopedArgs(['--scope=pkg-a/src', eq, 'widget'], {
      cwd: join(root, 'pkg-a'),
      repoRoot: root,
    });
    expect(withPositional).toEqual({ ok: true, args: [eq, 'pkg-a/src/bar-widget.test.ts'] });
  });

  it('本当に範囲外の位置引数は、値を取るフラグと併用しても今までどおり断られる（範囲内に一致なし）', async () => {
    const root = makeScopeFixtureRoot();
    const result = await resolveScopedArgs(['--scope=pkg-a/src', '--testTimeout', '5000', 'baz'], {
      cwd: join(root, 'pkg-a'),
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/範囲内に一致なし/);
    expect(result.message).toContain('「baz」');
  });

  it('範囲の外を明らかに指すパスも、値を取るフラグと併用して今までどおり断られる（範囲外）', async () => {
    const root = makeScopeFixtureRoot();
    const result = await resolveScopedArgs(
      ['--scope=pkg-a/src', '--retry', '2', '../pkg-b/src/baz.test.ts'],
      { cwd: join(root, 'pkg-a'), repoRoot: root },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/範囲外/);
  });

  it('値を取らない vitest のフラグ（--run）の直後の語は、位置引数として解決される', async () => {
    const root = makeScopeFixtureRoot();
    const result = await resolveScopedArgs(
      ['--scope=pkg-a/src', '--bail', '1', '--run', 'widget'],
      {
        cwd: join(root, 'pkg-a'),
        repoRoot: root,
      },
    );
    expect(result).toEqual({
      ok: true,
      args: ['--bail', '1', '--run', 'pkg-a/src/bar-widget.test.ts'],
    });
  });

  it('vitest の CLI 定義に無いフラグの直後のトークンは、範囲に持ち込まず断る（「判定できない」）', async () => {
    const root = makeScopeFixtureRoot();
    const result = await resolveScopedArgs(['--scope=pkg-a/src', '--noSuchFlag', 'widget'], {
      cwd: join(root, 'pkg-a'),
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/判定できない/);
    expect(result.message).toContain('--noSuchFlag widget');
  });

  it('vitest の CLI 定義を読めないとき（flagInfo: null）: 既知の少数以外は断る側へ倒れる', () => {
    const result = matchScopedPositionals(['--testTimeout', '5000'], 'pkg-a/src', {
      cwd: '/repo/pkg-a',
      repoRoot: '/repo',
      filesInScope: ['pkg-a/src/foo.test.ts'],
      flagInfo: null,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_SCOPE_VIOLATION);
    expect(result.message).toMatch(/読めなかった/);
  });

  it('次の vitest の版で増えるフラグ: 一覧に載れば手で足さなくても値として飲まれる（flagInfo を注入した純関数）', () => {
    const result = matchScopedPositionals(['--futureFlag', '9', 'foo'], 'pkg-a/src', {
      cwd: '/repo/pkg-a',
      repoRoot: '/repo',
      filesInScope: ['pkg-a/src/foo.test.ts'],
      flagInfo: { valueTaking: new Set(['--futureFlag']), booleans: new Set() },
    });
    expect(result).toEqual({
      ok: true,
      args: ['--futureFlag', '9', 'pkg-a/src/foo.test.ts'],
    });
  });

  it('loadVitestFlagInfo は node_modules の vitest から、値を取るフラグと取らないフラグを読む', async () => {
    const info = await loadVitestFlagInfo();
    expect(info).not.toBeNull();
    for (const f of ['--testTimeout', '--retry', '--bail', '--project', '-p', '--exclude', '-t']) {
      expect(info.valueTaking.has(f), f).toBe(true);
    }
    for (const f of ['--run', '--watch', '--coverage']) {
      expect(info.booleans.has(f), f).toBe(true);
    }
  });

  it('--deadline-seconds はラッパが先に食うので、空白区切りの値フラグと併用しても範囲判定に届かない', async () => {
    const root = makeScopeFixtureRoot();
    const deadline = extractDeadlineSeconds([
      '--scope=pkg-a/src',
      '--deadline-seconds',
      '200',
      '--testTimeout',
      '20000',
      'widget',
    ]);
    expect(deadline.ok).toBe(true);
    expect(deadline.deadlineSeconds).toBe(200);
    const result = await resolveScopedArgs(deadline.rest, {
      cwd: join(root, 'pkg-a'),
      repoRoot: root,
    });
    expect(result).toEqual({
      ok: true,
      args: ['--testTimeout', '20000', 'pkg-a/src/bar-widget.test.ts'],
    });
  });
});

describe('hasReporterFlag / resolveReporterArgs（既定の reporter を dot へ倒す。CLAUDECODE の有無を見る）', () => {
  it('hasReporterFlag: `--reporter=x`（`=` 形）を検出する', () => {
    expect(hasReporterFlag(['--maxWorkers=4', '--reporter=verbose'])).toBe(true);
  });

  it('hasReporterFlag: `--reporter x`（空白区切り）も検出する', () => {
    expect(hasReporterFlag(['--reporter', 'verbose'])).toBe(true);
  });

  it('hasReporterFlag: `--reporter` が無ければ false', () => {
    expect(hasReporterFlag(['--maxWorkers=4', 'a.test.ts'])).toBe(false);
  });

  it('CLAUDECODE が未設定なら、`--reporter` が無くても dot を足さない（人間の端末・GitHub Actions と同じ状態）', () => {
    const argv = ['a.test.ts'];
    expect(resolveReporterArgs(argv, { CLAUDECODE: undefined })).toEqual(argv);
  });

  it('CLAUDECODE が空文字列でも、未設定と同じ扱いにする（dot を足さない）', () => {
    const argv = ['a.test.ts'];
    expect(resolveReporterArgs(argv, { CLAUDECODE: '' })).toEqual(argv);
  });

  it('CLAUDECODE が設定されていても、利用者が `--reporter=verbose` を明示していれば変えない', () => {
    const argv = ['a.test.ts', '--reporter=verbose'];
    expect(resolveReporterArgs(argv, { CLAUDECODE: '1' })).toEqual(argv);
  });

  it('CLAUDECODE が設定されていても、利用者が `--reporter verbose`（空白区切り）を明示していれば変えない', () => {
    const argv = ['a.test.ts', '--reporter', 'verbose'];
    expect(resolveReporterArgs(argv, { CLAUDECODE: '1' })).toEqual(argv);
  });

  it('CLAUDECODE が設定されており、`--reporter` も明示していない（Claude Code の Bash ツール経由の実行そのもの）⟹ `--reporter=dot` を末尾へ足す', () => {
    const argv = ['a.test.ts', '--maxWorkers=2'];
    expect(resolveReporterArgs(argv, { CLAUDECODE: '1' })).toEqual([
      'a.test.ts',
      '--maxWorkers=2',
      '--reporter=dot',
    ]);
  });

  it('CLAUDECODE が設定されており、引数が空でも `--reporter=dot` だけを足す', () => {
    expect(resolveReporterArgs([], { CLAUDECODE: '1' })).toEqual(['--reporter=dot']);
  });
});

describe('extractDeadlineSeconds（`--deadline-seconds` を argv から取り出す。純粋関数）', () => {
  it('未指定なら deadlineSeconds は undefined、rest は argv そのまま', () => {
    const argv = ['a.test.ts', '--maxWorkers=2'];
    expect(extractDeadlineSeconds(argv)).toEqual({
      ok: true,
      deadlineSeconds: undefined,
      rest: argv,
    });
  });

  it('`=` 形（--deadline-seconds=300）を受け付け、vitest へは渡さない（rest から消える）', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=300', 'a.test.ts']);
    expect(result).toEqual({ ok: true, deadlineSeconds: 300, rest: ['a.test.ts'] });
  });

  it('空白区切り（--deadline-seconds 300）も受け付け、値ごと rest から消える', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds', '300', 'a.test.ts']);
    expect(result).toEqual({ ok: true, deadlineSeconds: 300, rest: ['a.test.ts'] });
  });

  it('前後の他の引数の順序を変えない（`=` 形）', () => {
    const result = extractDeadlineSeconds(['--maxWorkers=2', '--deadline-seconds=5', 'a.test.ts']);
    expect(result).toEqual({
      ok: true,
      deadlineSeconds: 5,
      rest: ['--maxWorkers=2', 'a.test.ts'],
    });
  });

  it('複数回指定されたら最後の値が勝つ（`extractScope` と同じ規約）', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=5', '--deadline-seconds=10']);
    expect(result).toEqual({ ok: true, deadlineSeconds: 10, rest: [] });
  });

  it('0 は拒否する（1以上でなければならない）', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=0']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('負の値は拒否する', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=-5']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('小数は拒否する', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=1.5']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('非数（数字でない文字列）は拒否する', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=abc']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('`=` の右側が空文字列でも拒否する', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('空白区切りで値が無い（末尾がフラグそのもの）ときも拒否する', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('空白区切りの次の要素が別のフラグ（`-` で始まる）なら、値が無いとして拒否する', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds', '--maxWorkers=2']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_BAD_DEADLINE);
  });

  it('不正な値のエラーメッセージは `test-guard:` で始まり、値を含む', () => {
    const result = extractDeadlineSeconds(['--deadline-seconds=-5']);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^test-guard:/);
    expect(result.message).toContain('-5');
  });
});

describe('formatDeadlineMessage（打ち切ったときに stdout へ必ず出す1行）', () => {
  it('`test-guard:` で始まり、締め切りの秒数と skill への案内を含む', () => {
    const message = formatDeadlineMessage(5);
    expect(message).toMatch(/^test-guard:/);
    expect(message).toContain('--deadline-seconds=5');
    expect(message).toContain('5 秒');
    expect(message).toContain('.claude/skills/test-in-chunks/SKILL.md');
  });

  it('「通ったのでも落ちたのでもない」ことを明示する（歯Aの `EXIT_UNKNOWN` と混同されないため）', () => {
    expect(formatDeadlineMessage(300)).toContain('通ったのでも落ちたのでもない');
  });
});

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
    expect(hits.map((h: { matched: string }) => h.matched)).toEqual([
      `it${dotSkip()}`,
      `test${dotSkip()}`,
    ]);
    expect(hits.map((h: { line: number }) => h.line)).toEqual([1, 2]);
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
    expect(hits.map((h: { path: string }) => h.path)).toEqual([
      'a.test.ts',
      'b.test.ts',
      'b.test.ts',
    ]);
  });

  it('スキップが無ければ空配列', () => {
    const content = "it('a', () => { expect(1).toBe(1); });";
    expect(findUnconditionalSkips([{ path: 'f.test.ts', content }])).toEqual([]);
  });
});

// `it` と `.skip` の間へ意図して半角スペースを挟んで書く: 呼び出し構文をそのまま書くと、歯Bの本番スキャンがこのファイル自身を「無条件の静的 skip」として検出するため。
describe('findUnconditionalSkips（歯B: マネージャー実測の13ケース。#311 差し戻し）', () => {
  const cases: Array<{ label: string; want: boolean; build: () => string }> = [
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
  // 実リポジトリの状態をアサートしない: 無条件 skip を置いた人が最初に見る赤が説明の無いアサーションになり、vitest が非0で終わるため `test.mjs` は歯Bを回さなくなる。
  it('実在の ROOT に対して回すと「判定できない」へ倒れない（走査の配線だけを見る。状態はアサートしない）', async () => {
    const result = await runStaticSkipGuard(ROOT);
    if (result.ok) {
      expect(result.scanned).toBeGreaterThan(0);
    } else {
      expect(result.exitCode).not.toBe(EXIT_SCAN_EMPTY);
    }
  });

  function makeStaticSkipRoot(body: string) {
    const dir = makeTempDirSync('test-guard-static-skip-');
    writeFileSync(
      join(dir, 'vitest.config.ts'),
      "export default { test: { include: ['**/*.test.ts'] } };\n",
    );
    writeFileSync(join(dir, 'fixture.test.ts'), body);
    return dir;
  }

  it('合成ルート: 無条件 skip が1件在ると EXIT_STATIC_SKIP と歯Bの文言が返る', async () => {
    const root = makeStaticSkipRoot(`it${dotSkip()}('止めたまま', () => {});\n`);
    const result = await runStaticSkipGuard(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_STATIC_SKIP);
      expect(result.message).toContain('無条件の静的 skip が 1 件見つかった');
      expect(result.message).toContain('fixture.test.ts:1');
      expect(result.message).toContain('skipIf');
    }
  });

  it('合成ルート: 無条件 skip が無ければ合格になる（走査は1ファイル）', async () => {
    const root = makeStaticSkipRoot("it('動く', () => {});\n");
    const result = await runStaticSkipGuard(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scanned).toBe(1);
    }
  });

  it('存在しないルートを渡すと「判定できない」に倒れる（0ファイル、EXIT_SCAN_EMPTY）', async () => {
    const result = await runStaticSkipGuard('/nonexistent-root-for-test-guard-core-test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_SCAN_EMPTY);
    }
  });
});

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
  // 実リポジトリの状態をアサートしない: 申告不備を置いた人が最初に見る赤が説明の無いアサーションになり、vitest が非0で終わるため `test.mjs` は歯Cを回さなくなる。
  it('実在の ROOT に対して回すと「判定できない」へ倒れない（走査の配線だけを見る。状態はアサートしない）', async () => {
    const result = await runObservationGuard(ROOT, '2026-08-27');
    if (result.ok) {
      expect(result.scanned).toBeGreaterThan(0);
    } else {
      expect(result.exitCode).not.toBe(EXIT_SCAN_EMPTY);
    }
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

  // 実リポジトリの状態をアサートしない: 期限が来た人が最初に見る赤が説明の無いアサーションになり、vitest が非0で終わるため `test.mjs` は歯Cを回さなくなる。
  const utcDay = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  function makeObservationRoot(deadline: string) {
    const dir = makeTempDirSync('test-guard-observation-');
    writeFileSync(
      join(dir, 'vitest.config.ts'),
      "export default { test: { include: ['**/*.test.ts'] } };\n",
    );
    writeFileSync(
      join(dir, 'fixture.observed.test.ts'),
      [
        '/**',
        ' * 終了条件: この合成ルートは既定引数を測るためだけに在る',
        ` * 見直し期限: ${deadline}`,
        ' */',
        '',
      ].join('\n'),
    );
    return dir;
  }

  function makeUndeclaredObservationRoot() {
    const dir = makeTempDirSync('test-guard-observation-undeclared-');
    writeFileSync(
      join(dir, 'vitest.config.ts'),
      "export default { test: { include: ['**/*.test.ts'] } };\n",
    );
    writeFileSync(
      join(dir, 'fixture.observed.test.ts'),
      ['/**', ' * 名乗ってはいるが、終了条件も見直し期限も書いていない。', ' */', ''].join('\n'),
    );
    return dir;
  }

  it('合成ルート: 申告不備は EXIT_OBSERVATION_UNDECLARED と歯Cの文言（2項目と SKILL.md への導線）になる', async () => {
    const root = makeUndeclaredObservationRoot();
    const result = await runObservationGuard(root, '2026-08-27');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_OBSERVATION_UNDECLARED);
      expect(result.message).toContain('申告不備');
      expect(result.message).toContain('fixture.observed.test.ts:1');
      expect(result.message).toContain('終了条件');
      expect(result.message).toContain('見直し期限');
      expect(result.message).toContain('.claude/skills/observation-tests/SKILL.md');
    }
  });

  it('today を渡さなければ既定値が「今日（UTC）」になる——期限が昨日の根では期限超過、今日の根では合格', async () => {
    const dueRoot = makeObservationRoot(utcDay(-1));
    const notYetRoot = makeObservationRoot(utcDay(0));
    const due = await runObservationGuard(dueRoot);
    expect(due.ok).toBe(false);
    if (!due.ok) {
      expect(due.exitCode).toBe(EXIT_OBSERVATION_DUE);
    }
    const notYet = await runObservationGuard(notYetRoot);
    expect(notYet.ok).toBe(true);
  });
});

// 逐語一致ではなく件数で測る・`>= 1` でなく `=== 1` で撃つ: 引用符1文字の違いで赤くならず、起こし方の形が変わって件数が0になったときも赤くするため。
// フィクスチャを持たず実物の `scripts/test.mjs` を読む: 持つと実物がどう変わっても緑のままになるため。
describe('scripts/test.mjs は vitest を1回しか起こさない（test-guard-core.mjs の「最初の1件」実装が安全である前提そのものの歯）', () => {
  const TEST_MJS_PATH = join(import.meta.dirname, 'test.mjs');
  const testMjsSource = readFileSync(TEST_MJS_PATH, 'utf8');

  const VITEST_CHILD_PROCESS_INVOCATION =
    /(spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"]vitest['"]/g;

  // `expect(TEST_MJS_PATH).toBe(join(ROOT, 'scripts', 'test.mjs'))` にしない: 両辺とも `import.meta.dirname` 由来で、どう壊しても赤くならない同語反復になるため。`package.json` の `scripts.test` と突き合わせる。
  it('この describe が読んでいるのは `pnpm test` が実際に起こす入り口そのものである（package.json の scripts.test と突き合わせる。パスの自己比較ではない）', () => {
    const packageJsonPath = join(ROOT, 'package.json');
    const testScript = JSON.parse(readFileSync(packageJsonPath, 'utf8'))?.scripts?.test;
    const entryToken = String(testScript ?? '')
      .split(/\s+/)
      .find((token) => token.endsWith('.mjs'));

    const notFoundMessage = [
      '`package.json` の `scripts.test` から `.mjs` で終わるトークンを',
      '取り出せなかった。この describe が読んでいるファイル',
      `（${TEST_MJS_PATH}）が \`pnpm test\` の入り口と同一かどうかを、`,
      'そもそも突き合わせられない。',
      '',
      `実測: \`scripts.test\` = ${JSON.stringify(testScript)}`,
    ].join('\n');
    expect(entryToken, notFoundMessage).toBeDefined();

    const mismatchMessage = [
      'この describe（`scripts/test.mjs は vitest を1回しか起こさない…`）が',
      '`readFileSync` で読んでいるファイルと、`pnpm test` が実際に起こす',
      '入り口が食い違っている。⟹ 直下の2本（起動件数・呼び出し件数）が',
      '緑でも、それは `pnpm test` が実際に走らせるファイルについて何も',
      '言っていない——別ファイルを検査して「安全」と言っていたことになる。',
      '',
      `実測: \`scripts.test\` = ${JSON.stringify(testScript)}`,
      `取り出した入り口 = ${JSON.stringify(entryToken)}`,
      `この describe が読んでいるのは = ${TEST_MJS_PATH}`,
    ].join('\n');
    expect(resolve(ROOT, entryToken ?? ''), mismatchMessage).toBe(TEST_MJS_PATH);
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

  // コメントと文字列リテラルを落としてから呼び出し構文で数える: 「runVitest は1回しか呼ばない」という注意書きを1行足しただけで件数が変わり、ふるまい不変なのに赤くなるため。
  it('runVitest の呼び出し箇所の件数はちょうど 1 である（定義は数えない。直上の「起動」件数の歯とは別の次元）', () => {
    const STRIP_COMMENTS_AND_STRINGS_RE =
      /(`(?:\\.|[^`\\])*`)|('(?:\\.|[^'\\])*')|("(?:\\.|[^"\\])*")|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)/g;

    function stripCommentsAndStringLiterals(source: string): string {
      return source.replace(
        STRIP_COMMENTS_AND_STRINGS_RE,
        (_match, _template, _single, _double, lineComment, blockComment) =>
          lineComment || blockComment ? '' : '""',
      );
    }

    const RUN_VITEST_CALL_SITE_RE = /(?<!function\s+)\brunVitest\s*\(/g;

    const stripped = stripCommentsAndStringLiterals(testMjsSource);
    const matches = stripped.match(RUN_VITEST_CALL_SITE_RE) ?? [];

    const message = [
      "直上の歯が数えているのは `spawn('vitest'` という**起動**の記述の件数",
      'であって、`runVitest` の**呼び出し**ではない。`spawn` は `runVitest`',
      '関数の本体の中に1つだけあるので、誰かが `main()` の中へ',
      '`await runVitest(args)` をもう1回書いても、直上の歯の件数は1のままで',
      '気づけない——だからこの歯を別に置く。',
      '',
      '件数が2以上なら: `runVitest` の呼び出しが増えている。実行時には',
      '集計ブロックが複数出るようになる。この歯の数字（下の `toBe(1)`）を',
      '直す前に、`scripts/mutate-core-strip-ansi.test.ts` に記録されている',
      '7経路を当たり直して、複数ブロックが `test-guard-core.mjs` の',
      '`parseAggregateLines` へ届くようになっていないかを測ること',
      "（`command grep -Fn -- '潰した経路は7本' scripts/mutate-core-strip-ansi.test.ts`",
      'で当たる）。届くようになっていたら、直す番なのは `test-guard-core.mjs`',
      'の側である。',
      '',
      '件数が0なら: `runVitest` の呼び出しの書き方が変わって、この歯の',
      '数え方では数えられなくなった。「名前が変わっただけなのに落ちた」では',
      'なく、**この歯の観測手段そのものが壊れた＝測り直せ**という合図である。',
      '',
      `実測: \`scripts/test.mjs\` の中で \`runVitest\` を呼び出している箇所 = ${matches.length} 件`,
      `（一致した文字列: ${JSON.stringify(matches)}）`,
    ].join('\n');

    expect(matches.length, message).toBe(1);
  });
});

describe('scripts/test.mjs の main() は dropBareDashDash を実際に通す（配線の歯）', () => {
  const testMjsSource = readFileSync(join(import.meta.dirname, 'test.mjs'), 'utf8');

  it('`process.argv.slice(2)` は `dropBareDashDash` を経由せずに直接 `runVitest` / `spawn` へは渡っていない', () => {
    const rawArgvUsage = (testMjsSource.match(/.*process\.argv\.slice\(2\).*/g) ?? []).filter(
      (line) => !/^\s*(\*|\/\/)/.test(line),
    );
    const message = [
      '`process.argv.slice(2)` を読んでいる行が見つからない、または複数ある。',
      'この歯は `main()` が argv を読む箇所が1行であることを前提にしている——',
      '書き方が変わったなら、この歯も測り直すこと。',
      `実測: ${JSON.stringify(rawArgvUsage)}`,
    ].join('\n');
    expect(rawArgvUsage.length, message).toBe(1);
    expect(rawArgvUsage[0], message).toMatch(/dropBareDashDash\(process\.argv\.slice\(2\)\)/);
  });

  it('`dropBareDashDash` を `test-guard-core.mjs` から import している（別の同名関数を自前で持っていない）', () => {
    const importBlock = testMjsSource.match(
      /import\s*\{[^}]*\}\s*from\s*'\.\/test-guard-core\.mjs'/,
    );
    expect(importBlock, 'test-guard-core.mjs からの import ブロックが見つからない').not.toBeNull();
    expect(importBlock?.[0]).toContain('dropBareDashDash');
  });
});
