import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { ALLOWLIST, ALLOWLIST_MISSING_ENV, classifyChildProcessCallEnv, classifyEnvPassthroughHits, findEnvPassthroughHits, findMissingEnvChildProcessCalls, isTargetPath, listTargetFiles, maskCommentsAndStrings } from './check-no-env-passthrough-core.mjs';

const ROOT = join(import.meta.dirname, '..');

interface Hit {
  path: string;
  line: number;
  kind: string;
  describe: string;
  snippet: string;
}

interface AllowlistEntry {
  path: string;
  reason: string;
}

describe('check-no-env-passthrough: maskCommentsAndStrings', () => {
  it('行コメントの中身を拾わない（同じ長さの空白へ置き換える）', () => {
    const src = '// { ...process.env }\nconst x = 1;';
    const masked = maskCommentsAndStrings(src) as string;
    expect(masked).not.toContain('process.env');
    expect(masked.split('\n').length).toBe(src.split('\n').length);
  });

  it('ブロックコメント（複数行）の中身を拾わない。行番号は保つ', () => {
    const src = '/**\n * { ...process.env }\n */\nconst x = 1;';
    const masked = maskCommentsAndStrings(src) as string;
    expect(masked).not.toContain('process.env');
    expect(masked.split('\n').length).toBe(src.split('\n').length);
  });

  it('文字列リテラル（シングル・ダブル）の中身を拾わない', () => {
    const src1 = "const t = 'env を渡すと { ...process.env, X } になる';";
    const src2 = 'const t = "env を渡すと { ...process.env, X } になる";';
    expect(maskCommentsAndStrings(src1)).not.toContain('process.env');
    expect(maskCommentsAndStrings(src2)).not.toContain('process.env');
  });

  it('テンプレートリテラルの中身を拾わない。`${…}` の中はコードとして残す', () => {
    const src = 'const t = `env=${JSON.stringify(process.env)}`;\nconst y = 1;';
    const masked = maskCommentsAndStrings(src) as string;
    expect(masked).toContain('process.env');
    expect(masked.split('\n').length).toBe(src.split('\n').length);
  });

  it('行番号がずれない（複数行のブロックコメントの後のコードが正しい行に残る）', () => {
    const src = 'const a = 1;\n/*\nfoo\nbar\n*/\nconst b = { ...process.env };';
    const masked = maskCommentsAndStrings(src) as string;
    const lines = masked.split('\n');
    expect(lines.length).toBe(6);
    expect(lines[5]).toContain('process.env');
  });
});

describe('check-no-env-passthrough: findEnvPassthroughHits', () => {
  it('`...process.env`（スプレッド）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const o = { ...process.env, PATH: 'x' };" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['spread-process-env']);
  });

  it('`env: process.env`（直接そのまま）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "spawn('git', args, { cwd, env: process.env });" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['env-direct-process-env']);
  });

  it('`Object.assign(…, process.env)` を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const env = Object.assign({}, process.env, { X: '1' });" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['object-assign-process-env']);
  });

  it('複数行にまたがる `Object.assign(…, process.env)` も検出する', () => {
    const hits = findEnvPassthroughHits([
      {
        path: 'a.test.ts',
        content: 'const env = Object.assign(\n  {},\n  process.env,\n  { X: "1" },\n);',
      },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['object-assign-process-env']);
  });

  it('⚠️ 回帰: `process.env.FOO`（プロパティアクセス）は誤検出しない', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const env = { PATH: process.env.PATH ?? '' };" },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 回帰: `env: gitChildEnv()`（ヘルパー呼び出し）は誤検出しない', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "execFileSync('git', args, { cwd, env: gitChildEnv() });" },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 回帰: shorthand（`env`）は測らない形として拾わない（意図した限界）', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: 'const env = buildEnv();\nspawn("x", [], { env });' },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 回帰: 行コメントに書かれた逐語の解説文は検出しない（usage-probe.test.ts と同じ形）', () => {
    const content = [
      "it('env を渡すと { ...process.env, ...渡した値 } になる（丸ごと置き換わらない）', async () => {",
      '  // process.env に既に在る変数（PATH）が残っていることまで見る。',
      '  expect(process.env.PATH).toBeDefined();',
      '});',
    ].join('\n');
    const hits = findEnvPassthroughHits([{ path: 'usage-probe.test.ts', content }]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 回帰: ブロックコメント中の `let{...,env:c={...process.env},...}=this.options` の引用は検出しない', () => {
    const content = [
      '/**',
      ' * 実際に読んだ該当行:',
      ' *',
      ' * ```',
      ' * let{...,env:c={...process.env},...}=this.options',
      ' * ```',
      ' */',
      'const x = 1;',
    ].join('\n');
    const hits = findEnvPassthroughHits([{ path: 'x.test.ts', content }]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('1ファイルの複数ファイルのうち、当たりのあるものだけを返す', () => {
    const hits = findEnvPassthroughHits([
      { path: 'clean.test.ts', content: "const env = { PATH: process.env.PATH ?? '' };" },
      { path: 'dirty.test.ts', content: 'const env = { ...process.env };' },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['dirty.test.ts']);
  });
});

describe('check-no-env-passthrough: findEnvPassthroughHits（Issue #2036 追加分。括弧を挟んだ形と計算プロパティ）', () => {
  it('`Object.assign(getBase(), process.env)`（process.env の前に丸括弧を含む式が在る）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: 'const env = Object.assign(getBase(), process.env);' },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['object-assign-process-env']);
  });

  it('⚠️ 対照: `Object.assign({}, other)`（process.env を含まない）は検出しない', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: 'const env = Object.assign({}, other);' },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('`{ ...(process.env), FOO: "1" }`（スプレッドが丸括弧で process.env を包む）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const o = { ...(process.env), FOO: '1' };" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['spread-process-env']);
  });

  it('⚠️ 対照: `...(someObj)`（process.env を包まない）は検出しない', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: 'const o = { ...(someObj), FOO: "1" };' },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it("`{ ['env']: process.env }`（計算プロパティ名の文字列キー）を検出する", () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const o = { ['env']: process.env };" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['computed-env-key-process-env']);
  });

  it('⚠️ 対照: `{ [\'env2\']: process.env }`（"env" と一致しないキー）は検出しない', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const o = { ['env2']: process.env };" },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it("⚠️ 回帰: コメント中の `['env']: process.env` の逐語引用は検出しない", () => {
    const content = [
      '/**',
      " * 実際に読んだ該当行: { ['env']: process.env }",
      ' */',
      'const x = 1;',
    ].join('\n');
    const hits = findEnvPassthroughHits([{ path: 'x.test.ts', content }]) as Hit[];
    expect(hits).toEqual([]);
  });
});

describe('check-no-env-passthrough: findEnvPassthroughHits（Issue #2042。#2036 の隣に在った見逃し）', () => {
  it("`{ 'env': process.env }`（引用符付きの普通のキー。シングルクォート）を検出する", () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "spawn('a', [], { 'env': process.env });" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['quoted-env-key-process-env']);
  });

  it('`{ "env": process.env }`（引用符付きの普通のキー。ダブルクォート）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: 'spawn(\'a\', [], { "env": process.env });' },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['quoted-env-key-process-env']);
  });

  it('`{ env: (process.env) }`（丸括弧で包んだ値）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "spawn('a', [], { env: (process.env) });" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['env-direct-process-env']);
  });

  it('`{ env: (process.env as NodeJS.ProcessEnv) }`（丸括弧 + 型アサーション）を検出する', () => {
    const hits = findEnvPassthroughHits([
      {
        path: 'a.test.ts',
        content: "spawn('a', [], { env: (process.env as NodeJS.ProcessEnv) });",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['env-direct-process-env']);
  });

  it('`{ [`env`]: process.env }`（テンプレートリテラルの計算キー）を検出する', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "spawn('a', [], { [`env`]: process.env });" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['computed-env-key-process-env']);
  });

  it("`{ ['env']: (process.env) }`（計算キー + 丸括弧で包んだ値）を検出する", () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "spawn('a', [], { ['env']: (process.env) });" },
    ]) as Hit[];
    expect(hits.map((h) => h.kind)).toEqual(['computed-env-key-process-env']);
  });

  it('⚠️ 対照: `{ \'foo\': process.env.X }`（"env" 以外の引用符付きキー。プロパティアクセス）は検出しない', () => {
    const hits = findEnvPassthroughHits([
      { path: 'a.test.ts', content: "const o = { 'foo': process.env.X };" },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it("⚠️ 回帰: コメント中の `{ 'env': process.env }` の逐語引用は検出しない", () => {
    const content = [
      '/**',
      " * 実際に読んだ該当行: { 'env': process.env }",
      ' */',
      'const x = 1;',
    ].join('\n');
    const hits = findEnvPassthroughHits([{ path: 'x.test.ts', content }]) as Hit[];
    expect(hits).toEqual([]);
  });
});

describe('check-no-env-passthrough: classifyChildProcessCallEnv（Issue #1971）', () => {
  it('env 無しの呼び出し（オプションそのものが無い）は missing-env', () => {
    expect(classifyChildProcessCallEnv('execFileSync', ["'git'", "['status']"])).toBe(
      'missing-env',
    );
  });

  it('args 配列だけで options が無い形（2引数）も missing-env', () => {
    expect(classifyChildProcessCallEnv('spawnSync', ["'git'", "['status']"])).toBe('missing-env');
  });

  it('command だけ（1引数のみ）も missing-env', () => {
    expect(classifyChildProcessCallEnv('execSync', ["'ls'"])).toBe('missing-env');
  });

  it('options オブジェクトに env キーが在れば has-env', () => {
    expect(
      classifyChildProcessCallEnv('execFileSync', [
        "'git'",
        "['status']",
        '{ cwd, env: gitChildEnv() }',
      ]),
    ).toBe('has-env');
  });

  it('options オブジェクトに env の shorthand（`{ env }`）が在っても has-env', () => {
    expect(classifyChildProcessCallEnv('spawnSync', ["'git'", "['status']", '{ env }'])).toBe(
      'has-env',
    );
  });

  it('⚠️ 回帰: オプションを変数で渡す形は判定できない（undeterminable）', () => {
    expect(classifyChildProcessCallEnv('execFileSync', ["'git'", 'args', 'opts'])).toBe(
      'undeterminable',
    );
  });

  it('⚠️ 回帰: options オブジェクトが spread だけで env キーが無い形も判定できない', () => {
    expect(
      classifyChildProcessCallEnv('spawnSync', ["'git'", "['status']", '{ ...baseOpts, cwd }']),
    ).toBe('undeterminable');
  });

  it('options オブジェクトに env キーも spread も無ければ missing-env', () => {
    expect(classifyChildProcessCallEnv('execFileSync', ["'git'", "['status']", '{ cwd }'])).toBe(
      'missing-env',
    );
  });
});

describe('check-no-env-passthrough: findMissingEnvChildProcessCalls（Issue #1971）', () => {
  it('env を指定しない execFileSync 呼び出しを検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import { execFileSync } from 'node:child_process';\n" +
          "execFileSync('git', ['status'], { cwd: '.' });",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('env: gitChildEnv() が在れば検出しない（回帰）', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import { execFileSync } from 'node:child_process';\n" +
          "execFileSync('git', ['status'], { cwd: '.', env: gitChildEnv() });",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('オプションを変数で渡す形は検出しない（判定できないので赤にも緑にも倒さない）', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import { execFileSync } from 'node:child_process';\n" +
          'const opts = buildOpts();\n' +
          "execFileSync('git', ['status'], opts);",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('promisify(execFile) 経由の別名呼び出しも検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import { execFile } from 'node:child_process';\n" +
          "import { promisify } from 'node:util';\n" +
          'const run = promisify(execFile);\n' +
          "run('node', ['-e', 'x']);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('promisify(execFile) 経由でも env を渡していれば検出しない（回帰）', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import { execFile } from 'node:child_process';\n" +
          "import { promisify } from 'node:util';\n" +
          'const run = promisify(execFile);\n' +
          "run('node', ['-e', 'x'], { env: { PATH: process.env.PATH ?? '' } });",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('child_process を import していないファイルは何も検出しない（誤爆しない）', () => {
    const hits = findMissingEnvChildProcessCalls([
      { path: 'a.test.ts', content: "exec('not a real call, no import');" },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 回帰: コメント中の解説文（env 無しの呼び出し例）は検出しない', () => {
    const content = [
      "import { execFileSync } from 'node:child_process';",
      '// 例: execFileSync("git", ["status"]) は env を継ぐ',
      "execFileSync('git', ['status'], { cwd: '.', env: gitChildEnv() });",
    ].join('\n');
    const hits = findMissingEnvChildProcessCalls([{ path: 'a.test.ts', content }]) as Hit[];
    expect(hits).toEqual([]);
  });
});

describe('check-no-env-passthrough: findMissingEnvChildProcessCalls（Issue #2045。別名・require・名前空間・動的 import）', () => {
  it('別名の named import（`import { spawn as sp }` → `sp(...)`）を検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import { spawn as sp } from 'node:child_process';\nsp('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('⚠️ 回帰: 別名の named import でも env を渡していれば検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import { spawn as sp } from 'node:child_process';\n" +
          "sp('x', [], { env: gitChildEnv() });",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it("`const { spawn } = await import('node:child_process')`（動的 import の分割代入）を検出する", () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "const { spawn } = await import('node:child_process');\nspawn('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('動的 import の分割代入 + リネーム（`{ spawn: sp }`）も検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "const { spawn: sp } = await import('node:child_process');\nsp('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it("`const { spawn } = require('node:child_process')`（require の分割代入）を検出する", () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "const { spawn } = require('node:child_process');\nspawn('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('require の分割代入 + リネーム（`{ spawn: sp }`）も検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "const { spawn: sp } = require('node:child_process');\nsp('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it("`const cp = require('child_process'); cp.spawn(...)`（名前空間 require）を検出する", () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "const cp = require('child_process');\ncp.spawn('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it("`import * as cp from 'node:child_process'; cp.spawn(...)`（名前空間 import）を検出する", () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import * as cp from 'node:child_process';\ncp.spawn('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it("`import cp from 'node:child_process'; cp.spawn(...)`（既定の import）を検出する", () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import cp from 'node:child_process';\ncp.spawn('x');",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('⚠️ 回帰: 名前空間経由でも env を渡していれば検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import * as cp from 'node:child_process';\n" +
          "cp.spawn('x', [], { env: gitChildEnv() });",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 回帰: 別名 import 経由でも args 配列だけの2引数呼び出しは missing-env として分類される（元の名前で ARGS_ARRAY_FAMILY を照らす）', () => {
    // command（第1引数）を文字列リテラルにしない: マスクで潰れた要素が捨てられて args 列の位置がずれ、family の分岐に関係なく `missing-env` になるため。
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import { spawn as sp } from 'node:child_process';\nsp(cmdVar, ['-e', 'y']);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('⚠️ 対照: コメントに書かれた別名 import の逐語引用は検出しない', () => {
    const content = ["// import { spawn as sp } from 'node:child_process';", 'const x = 1;'].join(
      '\n',
    );
    const hits = findMissingEnvChildProcessCalls([{ path: 'a.test.ts', content }]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 対照: `child_process` と無関係な `cp.spawn(...)`（`cp` が別モジュールの名前空間）は検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import * as cp from 'node:some-other-module';\ncp.spawn('x');",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 対照: `child_process` の import が無い、ただのオブジェクトの `cp.spawn(...)` は検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "const cp = { spawn: () => {} };\ncp.spawn('x');",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('既定の import と named の併記（`import cp, { spawn }`）の `spawn(...)` を検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import cp, { spawn } from 'node:child_process';\nspawn(cmd);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('既定の import と named の併記の、既定の側の `cp.spawn(...)` を検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import cp, { execFile } from 'node:child_process';\ncp.spawn(cmd);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('既定の import と名前空間の併記（`import cp, * as ns`）の `ns.spawn(...)` を検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import cp, * as ns from 'node:child_process';\nns.spawn(cmd);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('名前空間の名前に `$` を含む（`$cp.spawn(...)`）呼び出しを検出する', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import * as $cp from 'node:child_process';\n$cp.spawn(cmd);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('⚠️ 対照: `import type` だけの行は束縛を作らないので、同名の `spawn(...)` を検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import type { SpawnOptions } from 'node:child_process';\nspawn(cmd);",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });
});

describe('check-no-env-passthrough: findMissingEnvChildProcessCalls（promisify を名前空間経由で包む形。PR #2062 の隣に在った見逃し）', () => {
  const withoutEnv = "run('node', ['-e', 'x']);";
  const withEnv = "run('node', ['-e', 'x'], { env: { PATH: '/usr/bin' } });";
  const cases: Array<{ name: string; head: string }> = [
    {
      name: 'promisify(cp.execFile)（import * as cp）',
      head:
        "import * as cp from 'node:child_process';\n" +
        "import { promisify } from 'node:util';\n" +
        'const run = promisify(cp.execFile);\n',
    },
    {
      name: 'promisify(childProcess.exec)（import childProcess from）',
      head:
        "import childProcess from 'node:child_process';\n" +
        "import { promisify } from 'node:util';\n" +
        'const run = promisify(childProcess.exec);\n',
    },
    {
      name: 'util.promisify(cp.execFile)（import * as util）',
      head:
        "import * as cp from 'node:child_process';\n" +
        "import * as util from 'node:util';\n" +
        'const run = util.promisify(cp.execFile);\n',
    },
    {
      name: 'util.promisify(execFile)（named import + util 経由）',
      head:
        "import { execFile } from 'node:child_process';\n" +
        "import * as util from 'node:util';\n" +
        'const run = util.promisify(execFile);\n',
    },
    {
      name: 'promisify(cp.execFile)（const cp = require(...)）',
      head:
        "const cp = require('node:child_process');\n" +
        "const { promisify } = require('node:util');\n" +
        'const run = promisify(cp.execFile);\n',
    },
    {
      name: 'const { execFile } = cp; promisify(execFile)（名前空間からの分割代入）',
      head:
        "import * as cp from 'node:child_process';\n" +
        "import { promisify } from 'node:util';\n" +
        'const { execFile } = cp;\n' +
        'const run = promisify(execFile);\n',
    },
  ];

  for (const { name, head } of cases) {
    it(`${name}: env 無しの別名呼び出しを検出する`, () => {
      const hits = findMissingEnvChildProcessCalls([
        { path: 'a.test.ts', content: head + withoutEnv },
      ]) as Hit[];
      expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
    });

    it(`${name}: env を渡していれば検出しない（回帰）`, () => {
      const hits = findMissingEnvChildProcessCalls([
        { path: 'a.test.ts', content: head + withEnv },
      ]) as Hit[];
      expect(hits).toEqual([]);
    });
  }

  it('名前空間からの分割代入 `const { spawn: sp } = cp` の `sp(...)` を検出する（リネーム）', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content: "import * as cp from 'node:child_process';\nconst { spawn: sp } = cp;\nsp(cmd);",
      },
    ]) as Hit[];
    expect(hits.map((h) => h.path)).toEqual(['a.test.ts']);
  });

  it('⚠️ 対照: child_process の名前空間ではない変数のメンバー（promisify(other.execFile)）は検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import * as cp from 'node:child_process';\n" +
          "import * as other from './other';\n" +
          "import { promisify } from 'node:util';\n" +
          'const run = promisify(other.execFile);\n' +
          "run('node', ['-e', 'x']);",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 対照: 名前空間の別のメンバー（promisify(cp.ChildProcess)）は検出しない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import * as cp from 'node:child_process';\n" +
          "import { promisify } from 'node:util';\n" +
          'const run = promisify(cp.ChildProcess);\n' +
          "run('node', ['-e', 'x']);",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });

  it('⚠️ 対照: child_process ではない名前空間からの分割代入（const { execFile } = other）は束縛にしない', () => {
    const hits = findMissingEnvChildProcessCalls([
      {
        path: 'a.test.ts',
        content:
          "import * as cp from 'node:child_process';\n" +
          "import * as other from './other';\n" +
          'const { execFile } = other;\n' +
          "execFile('node', ['-e', 'x']);",
      },
    ]) as Hit[];
    expect(hits).toEqual([]);
  });
});

describe('check-no-env-passthrough: classifyEnvPassthroughHits', () => {
  it('ALLOWLIST に載ったパスの当たりは violations に出ない', () => {
    const hits: Hit[] = [
      {
        path: 'allowed.test.ts',
        line: 1,
        kind: 'spread-process-env',
        describe: '',
        snippet: '',
      },
    ];
    const allowlist: AllowlistEntry[] = [{ path: 'allowed.test.ts', reason: 'テスト用' }];
    const { violations, stale } = classifyEnvPassthroughHits(hits, allowlist) as {
      violations: Hit[];
      stale: AllowlistEntry[];
    };
    expect(violations).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('ALLOWLIST に無いパスの当たりは violations に出る', () => {
    const hits: Hit[] = [
      {
        path: 'not-allowed.test.ts',
        line: 1,
        kind: 'spread-process-env',
        describe: '',
        snippet: '',
      },
    ];
    const { violations } = classifyEnvPassthroughHits(hits, []) as { violations: Hit[] };
    expect(violations.map((h) => h.path)).toEqual(['not-allowed.test.ts']);
  });

  it('⚠️ 古い許可（当たりが無いのに ALLOWLIST に残っている）は stale に出る', () => {
    const allowlist: AllowlistEntry[] = [{ path: 'fixed-already.test.ts', reason: '古い理由' }];
    const { violations, stale } = classifyEnvPassthroughHits([], allowlist) as {
      violations: Hit[];
      stale: AllowlistEntry[];
    };
    expect(violations).toEqual([]);
    expect(stale.map((e) => e.path)).toEqual(['fixed-already.test.ts']);
  });
});

describe('check-no-env-passthrough: isTargetPath', () => {
  it('*.test.ts / *.test.tsx を対象にする', () => {
    expect(isTargetPath('scripts/foo.test.ts')).toBe(true);
    expect(isTargetPath('apps/web/app/routes/chat.test.tsx')).toBe(true);
  });

  it('*.test-support.ts / *.test-support.tsx を対象にする', () => {
    expect(isTargetPath('packages/core/src/git-child-env.test-support.ts')).toBe(true);
    expect(isTargetPath('apps/web/app/foo.test-support.tsx')).toBe(true);
  });

  it('ファイル名そのものが test-support.ts / test-support.tsx のものも対象にする', () => {
    expect(isTargetPath('apps/cli/src/test-support.ts')).toBe(true);
    expect(isTargetPath('apps/web/app/test-support.tsx')).toBe(true);
  });

  it('.claude/skills/mutation-testing/ 直下の *.mjs を対象にする', () => {
    expect(isTargetPath('.claude/skills/mutation-testing/mutate.mjs')).toBe(true);
    expect(isTargetPath('.claude/skills/mutation-testing/mutate-core.mjs')).toBe(true);
    expect(isTargetPath('.claude/skills/mutation-testing/mutate-selftest.mjs')).toBe(true);
  });

  it('.claude/skills/mutation-testing/ のサブディレクトリの *.mjs は対象にしない', () => {
    expect(isTargetPath('.claude/skills/mutation-testing/sub/other.mjs')).toBe(false);
  });

  it('対象外のファイルは対象にしない', () => {
    expect(isTargetPath('scripts/check-no-env-passthrough-core.mjs')).toBe(false);
    expect(isTargetPath('packages/core/src/manager.ts')).toBe(false);
    expect(isTargetPath('scripts/git-scannable-files-core.mjs')).toBe(false);
  });
});

describe('実リポジトリの検査（main が緑であることの確認、#1935）', () => {
  it('ALLOWLIST の each entry が listTargetFiles(ROOT) に実在する（消えたパスを残さない）', () => {
    const targetPaths = new Set(listTargetFiles(ROOT) as string[]);
    for (const entry of ALLOWLIST as AllowlistEntry[]) {
      expect(
        targetPaths.has(entry.path),
        `ALLOWLIST の \`${entry.path}\` が走査対象に無い（消えたなら ALLOWLIST からも消すこと）`,
      ).toBe(true);
      expect(entry.reason.trim().length > 0, `ALLOWLIST の \`${entry.path}\` の reason が空`).toBe(
        true,
      );
    }
  });

  it('対象ファイルに、許可されていない env 丸渡しが無い。ALLOWLIST に古い許可も残っていない', () => {
    const paths = listTargetFiles(ROOT) as string[];
    expect(paths.length).toBeGreaterThan(0);

    const files = paths.map((path) => ({ path, content: readFileSync(join(ROOT, path), 'utf8') }));
    const hits = findEnvPassthroughHits(files) as Hit[];
    const { violations, stale } = classifyEnvPassthroughHits(hits, ALLOWLIST) as {
      violations: Hit[];
      stale: AllowlistEntry[];
    };

    expect(
      violations,
      violations.length === 0
        ? ''
        : `${violations.length}件の未許可の env 丸渡し:\n` +
            violations
              .map((h) => `  ${h.path}:${h.line} ${h.describe}\n    ${h.snippet}`)
              .join('\n') +
            '\n必要な鍵だけを明示的に組み立てるか、理由付きで ALLOWLIST へ載せること（#1935）。',
    ).toEqual([]);

    expect(
      stale,
      stale.length === 0
        ? ''
        : `ALLOWLIST に古い許可が${stale.length}件残っている: ${stale.map((e) => e.path).join(', ')}\n` +
            '直してしまって当たりが無くなったなら、ALLOWLIST から消すこと。',
    ).toEqual([]);
  });

  it('ALLOWLIST_MISSING_ENV の each entry が listTargetFiles(ROOT) に実在する（消えたパスを残さない、#1971）', () => {
    const targetPaths = new Set(listTargetFiles(ROOT) as string[]);
    for (const entry of ALLOWLIST_MISSING_ENV as AllowlistEntry[]) {
      expect(
        targetPaths.has(entry.path),
        `ALLOWLIST_MISSING_ENV の \`${entry.path}\` が走査対象に無い（消えたなら ALLOWLIST_MISSING_ENV からも消すこと）`,
      ).toBe(true);
      expect(
        entry.reason.trim().length > 0,
        `ALLOWLIST_MISSING_ENV の \`${entry.path}\` の reason が空`,
      ).toBe(true);
    }
  });

  it('対象ファイルに、許可されていない env 無し子プロセス呼び出しが無い。ALLOWLIST_MISSING_ENV に古い許可も残っていない（#1971）', () => {
    const paths = listTargetFiles(ROOT) as string[];
    const files = paths.map((path) => ({ path, content: readFileSync(join(ROOT, path), 'utf8') }));
    const hits = findMissingEnvChildProcessCalls(files) as Hit[];
    const { violations, stale } = classifyEnvPassthroughHits(hits, ALLOWLIST_MISSING_ENV) as {
      violations: Hit[];
      stale: AllowlistEntry[];
    };

    expect(
      violations,
      violations.length === 0
        ? ''
        : `${violations.length}件の未許可の env 無し子プロセス呼び出し:\n` +
            violations
              .map((h) => `  ${h.path}:${h.line} ${h.describe}\n    ${h.snippet}`)
              .join('\n') +
            '\n必要な鍵だけを明示的に組み立てるか、理由付きで ALLOWLIST_MISSING_ENV へ載せること（#1971）。',
    ).toEqual([]);

    expect(
      stale,
      stale.length === 0
        ? ''
        : `ALLOWLIST_MISSING_ENV に古い許可が${stale.length}件残っている: ${stale.map((e) => e.path).join(', ')}\n` +
            '直してしまって当たりが無くなったなら、ALLOWLIST_MISSING_ENV から消すこと。',
    ).toEqual([]);
  });

  it('走査対象が空虚でない（マスクが壊れて中身を全部食べていないことの確認）', () => {
    const paths = listTargetFiles(ROOT) as string[];
    const combined = paths
      .map((path) => maskCommentsAndStrings(readFileSync(join(ROOT, path), 'utf8')) as string)
      .join('\n');
    expect(combined.length).toBeGreaterThan(10000);
    expect(combined).toContain('describe(');
  });
});
