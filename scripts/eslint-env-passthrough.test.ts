import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// `eslint.config.js` の env 受け渡しの規則（`no-restricted-syntax`。#1935・#1854・#1971・#2042）を、実物の設定のまま測る。
// 入力は旧検査 `check-no-env-passthrough` の試験から引き継いだもの。
const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function lint(code: string, filePath = 'scripts/probe.test.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

const CP = "import * as cp from 'node:child_process';\n";

describe('env の丸渡し: 捕まえる', () => {
  const cases: Array<[string, string]> = [
    ['`...process.env`', "const o = { ...process.env, PATH: 'x' };"],
    ['`...(process.env)`', "const o = { ...(process.env), FOO: '1' };"],
    ['`env: process.env`', "spawn('git', args, { cwd, env: process.env });"],
    ['`env: (process.env)`', "spawn('a', [], { env: (process.env) });"],
    [
      '`env: (process.env as NodeJS.ProcessEnv)`',
      "spawn('a', [], { env: (process.env as NodeJS.ProcessEnv) });",
    ],
    ['`Object.assign({}, process.env, …)`', "const env = Object.assign({}, process.env, { X: '1' });"],
    ['複数行の `Object.assign`', 'const env = Object.assign(\n  {},\n  process.env,\n  { X: "1" },\n);'],
    ['`Object.assign(getBase(), process.env)`', 'const env = Object.assign(getBase(), process.env);'],
    ["`'env': process.env`", "spawn('a', [], { 'env': process.env });"],
    ['`"env": process.env`', 'spawn(\'a\', [], { "env": process.env });'],
    ["`['env']: process.env`", "const o = { ['env']: process.env };"],
    ["`['env']: (process.env)`", "spawn('a', [], { ['env']: (process.env) });"],
    ['`` [`env`]: process.env ``', "spawn('a', [], { [`env`]: process.env });"],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      expect(await lint(code)).toBeGreaterThan(0);
    });
  }
});

describe('env の丸渡し: 捕まえない', () => {
  const cases: Array<[string, string]> = [
    ['`process.env.FOO`（プロパティアクセス）', "const env = { PATH: process.env.PATH ?? '' };"],
    ['`env: gitChildEnv()`', "execFileSync('git', args, { cwd, env: gitChildEnv() });"],
    ['shorthand `{ env }`', 'const env = buildEnv();\nspawn("x", [], { env });'],
    ['`Object.assign({}, other)`', 'const env = Object.assign({}, other);'],
    ['`...(someObj)`', 'const o = { ...(someObj), FOO: "1" };'],
    ["`['env2']: process.env`", "const o = { ['env2']: process.env };"],
    ["`'foo': process.env.X`", "const o = { 'foo': process.env.X };"],
    ['行コメントの解説文', '// { ...process.env, X }\nexpect(process.env.PATH).toBeDefined();'],
    ['ブロックコメントの引用', '/**\n * let{env:c={...process.env}}=this.options\n */\nconst x = 1;'],
    ["コメント中の `['env']: process.env`", "/** { ['env']: process.env } */\nconst x = 1;"],
    ["コメント中の `'env': process.env`", "/** { 'env': process.env } */\nconst x = 1;"],
    ['文字列の中', "const t = 'env を渡すと { ...process.env, X } になる';"],
    ['テンプレートリテラルの文字部分', 'const t = `env を渡すと { ...process.env } になる`;'],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      expect(await lint(code)).toBe(0);
    });
  }
});

describe('env 無しの子プロセスの呼び: 捕まえる', () => {
  const cases: Array<[string, string]> = [
    ['execFileSync(cmd, args, { cwd })', "execFileSync('git', ['status'], { cwd: '.' });"],
    ['execFileSync(cmd, args)', "execFileSync('git', ['status']);"],
    ['spawnSync(cmd, args)（2引数）', "spawnSync('git', ['status']);"],
    ['execSync(cmd)（1引数）', "execSync('ls');"],
    ['spawn(cmd)', "spawn('x');"],
    ['spawn(cmd, args)（コマンドが変数）', "spawn(cmdVar, ['-e', 'y']);"],
    ['execSync(cmd, { cwd })', "execSync('ls', { cwd });"],
    ['exec(cmd, callback)', "exec('ls', () => {});"],
    ['execFile(cmd, args, callback)', "execFile('ls', ['-l'], (e) => {});"],
    ['cp.spawn(cmd)（名前空間）', `${CP}cp.spawn('x');`],
    ['childProcess.exec(cmd)', "childProcess.exec('x');"],
    ['cp.spawn(cmd, args, { cwd })', `${CP}cp.spawn('x', [], { cwd });`],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      expect(await lint(code)).toBeGreaterThan(0);
    });
  }
});

describe('env 無しの子プロセスの呼び: 捕まえない', () => {
  const cases: Array<[string, string]> = [
    ['env: gitChildEnv()', "execFileSync('git', ['status'], { cwd: '.', env: gitChildEnv() });"],
    ['env の shorthand', "spawnSync('git', ['status'], { env });"],
    ['options を変数で渡す（判定できない）', "const opts = buildOpts();\nexecFileSync('git', ['status'], opts);"],
    ['options が spread だけ（判定できない）', "spawnSync('git', ['status'], { ...baseOpts, cwd });"],
    ['名前空間でも env を渡す', `${CP}cp.spawn('x', [], { env: gitChildEnv() });`],
    ['options 2引数目に env', "spawn('x', { env: gitChildEnv() });"],
    ['コメント中の呼び', '// 例: execFileSync("git", ["status"]) は env を継ぐ\nconst x = 1;'],
    ['`cp` が別のオブジェクトのメソッド', "const cp = { run: () => {} };\ncp.run('x');"],
    ['正規表現の `exec`（メンバー呼び）', 'const m = /a/.exec(s);'],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      expect(await lint(code)).toBe(0);
    });
  }
});

describe('env の受け渡し: 対象のファイルと許可', () => {
  const bad = 'const o = { ...process.env };';
  it('*.test.ts / *.test.tsx / *.test-support.ts / test-support.ts を対象にする', async () => {
    for (const p of [
      'scripts/foo.test.ts',
      'apps/web/app/routes/chat.test.tsx',
      'packages/core/src/git-child-env.test-support.ts',
      'apps/cli/src/test-support.ts',
    ]) {
      expect(await lint(bad, p), p).toBeGreaterThan(0);
    }
  });

  it('.claude/skills/mutation-testing/ 直下の *.mjs を対象にし、サブディレクトリは対象にしない', async () => {
    expect(await lint(bad, '.claude/skills/mutation-testing/mutate.mjs')).toBeGreaterThan(0);
    expect(await lint(bad, '.claude/skills/mutation-testing/sub/other.mjs')).toBe(0);
  });

  it('試験ではないファイルは対象にしない', async () => {
    expect(await lint(bad, 'packages/core/src/manager.ts')).toBe(0);
  });

  it('許可の3件は丸渡しを通す', async () => {
    for (const p of [
      '.github/scripts/update-claude-sdk.test.ts',
      'apps/daemon/src/runner-client.test.ts',
      'vitest.env-scrub.test.ts',
    ]) {
      expect(await lint(bad, p), p).toBe(0);
    }
  });
});
