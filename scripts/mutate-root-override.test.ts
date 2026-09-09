import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  BACKUP_DIR,
  DEFAULT_ROOT,
  HarnessError,
  MARKER_PATH,
  readRootArg,
  ROOT,
  setRootOverride,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * ROOT の対象取り違え（マネージャーの依頼の本題）を塞ぐ歯。
 *
 * **欠陥**: `mutate-core.mjs` の `ROOT` はスクリプト自身の位置から決まり、
 * 上書きする引数も環境変数も無かった。別の repo の中に立ってこの clone の
 * `mutate.mjs status` を呼ぶと、エラーにならず「このツリーに変異が当たった
 * ままの状態は無い」と答える——その「このツリー」が呼び出し元ではなく
 * この clone であることが、出力からは分からなかった。
 *
 * **直し方**: `--root <path>` で上書きできるようにし（CLI 層の `mutate.mjs`
 * が argv を読んで `mutate-core.mjs` の `setRootOverride` を呼ぶ。環境変数
 * ではない — `mutate-core.mjs` 冒頭「ここにテスト用の抜け道（環境変数で
 * 分岐する類）を作らない」）、上書きの有無に関わらず実効の ROOT を毎回
 * 出力へ1行出す。
 *
 * **ここに置く理由（CI で走らせるため）**: `mutate-selftest.mjs` の
 * `SELFTEST_SCENARIOS` を CI から呼ぶ箇所は無い（`.github/workflows/*.yml` /
 * `package.json` / `scripts/` を `grep -rFn` で全走査して確認済み——ゼロ件）。
 * `mutate-selftest.mjs` だけに歯を置くと CI では1本も走らない。
 * `vitest.config.ts` の `include` に `scripts` 配下の `*.test.ts` を拾うパターンが在り、
 * `scripts/mutate-max-workers.test.ts` / `scripts/mutate-core-strip-ansi.test.ts`
 * が先例（同じ「素の .mjs を plain import する」形）なので、それに揃える。
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

function runCli(args: string[]) {
  return spawnSync('node', [MUTATE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

/** git 管理下の使い捨てツリーを作る（apply/restore が gitHead() 等を呼ぶため）。 */
function makeTmpGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-root-override-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

// ── 純粋な層: readRootArg（argv 解析。副作用なし） ──────────────────

describe('mutate-core: readRootArg（--root の argv 解析）', () => {
  it('--root が無ければ undefined を返す（呼び出し側は override しない）', () => {
    expect(readRootArg([])).toBeUndefined();
    expect(readRootArg(['--spec', 'x.json'])).toBeUndefined();
  });

  it('--root <path> を読む', () => {
    expect(readRootArg(['--root', '/tmp/probe'])).toBe('/tmp/probe');
  });

  it('他の引数と混ざっていても読める', () => {
    expect(readRootArg(['--spec', 'x.json', '--root', '/tmp/probe'])).toBe('/tmp/probe');
  });

  it('--root に値が無ければ HarnessError（読む前に落ちる。何も上書きしない）', () => {
    expect(() => readRootArg(['--root'])).toThrow(HarnessError);
  });
});

// ── 純粋な層: setRootOverride の fail-closed 検証 ────────────────────
//
// **ここで確かめるのは失敗系だけである。** 成功系（3つの値をまとめて
// 差し替える）は、この直後の describe が1本だけ持つ——`ROOT` は module
// scope の可変状態なので、同一ファイル内で先に成功させると以降のテストが
// その上書き後の値を見てしまう。失敗系は ROOT を書き換えないことそのものが
// 主張なので、この順で置いても汚染しない。

describe('mutate-core: setRootOverride は不正な --root を fail-closed で拒否する', () => {
  it('空文字を拒否し、ROOT/MARKER_PATH/BACKUP_DIR のどれも書き換えない', () => {
    expect(() => setRootOverride('')).toThrow(HarnessError);
    expect(ROOT).toBe(DEFAULT_ROOT);
    expect(MARKER_PATH).toBe(path.join(DEFAULT_ROOT, 'MUTATION-IN-PROGRESS.json'));
    expect(BACKUP_DIR).toBe(path.join(DEFAULT_ROOT, '.mutation-testing', 'backups'));
  });

  it('存在しないパスを拒否する', () => {
    expect(() => setRootOverride('/nonexistent/mutate-root-override-probe')).toThrow(/存在しない/);
    expect(ROOT).toBe(DEFAULT_ROOT);
  });

  it('ディレクトリでないパス（このテストファイル自身）を拒否する', () => {
    expect(() => setRootOverride(__filename)).toThrow(/ディレクトリでない/);
    expect(ROOT).toBe(DEFAULT_ROOT);
  });
});

// ── 純粋な層: setRootOverride の成功系（3つ全部が変わることを名指しする） ──
//
// **歯1の核心**: ROOT だけでなく MARKER_PATH / BACKUP_DIR も同じ新しい ROOT
// から作り直されていることを、3つとも個別に検査する。ROOT だけを見る歯では、
// 「ROOT は新しい値を見て、印や控えは古い ROOT のまま」という欠陥（この PR が
// 名指しで潰そうとしている形）を見逃す。

describe('mutate-core: setRootOverride は ROOT/MARKER_PATH/BACKUP_DIR の3つをまとめて差し替える', () => {
  it('成功すると3つとも新しい ROOT から作り直される', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-root-override-pure-'));
    try {
      const result = setRootOverride(tmp);
      const resolvedTmp = path.resolve(tmp);

      expect(ROOT).toBe(resolvedTmp);
      expect(MARKER_PATH).toBe(path.join(resolvedTmp, 'MUTATION-IN-PROGRESS.json'));
      expect(BACKUP_DIR).toBe(path.join(resolvedTmp, '.mutation-testing', 'backups'));

      // 戻り値でも同じ3つを確認できる（呼び出し側が個別に import し直さなくてよい）。
      expect(result).toEqual({
        root: resolvedTmp,
        markerPath: path.join(resolvedTmp, 'MUTATION-IN-PROGRESS.json'),
        backupDir: path.join(resolvedTmp, '.mutation-testing', 'backups'),
      });

      // 既定（DEFAULT_ROOT）は変えていないことも確認する——上書きは
      // 「既定を書き換える」のではなく「別の値を指すようにする」である。
      expect(DEFAULT_ROOT).toBe(REPO_ROOT);
      expect(ROOT).not.toBe(DEFAULT_ROOT);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── CLI 層（mutate.mjs）を実プロセスとして起こす統合の歯 ─────────────
//
// **プロセスを分ける理由**: `mutate.mjs` はモジュール末尾で無条件に `main()`
// を呼ぶ（`mutate-core.mjs` の `readMaxWorkers` の doc と同じ理由）ので、
// plain import すると `process.argv` 次第でテストプロセスごと `exit()` する。
// `mutate-selftest.mjs` が実プロセスとして `mutate.mjs status` 等を起こす
// のと同じ形（execFileSync/spawnSync）に揃える。

describe('mutate.mjs CLI: --root（回帰・上書き・fail-closed・実効 ROOT の出力）', () => {
  it('歯2（回帰）: --root を渡さないと、既定の ROOT（このリポジトリ）のまま動く', () => {
    const result = runCli(['status']);
    expect(result.status === 0 || result.status === 2).toBe(true); // 印の有無どちらでも通る
    expect(result.stdout).toContain(`ROOT: ${REPO_ROOT}`);
    expect(result.stdout).toContain('既定。--root は渡されていない');
  });

  it('歯4: --root を渡さないときも実効 ROOT が出力に出る（既定であることが読める）', () => {
    const result = runCli(['status']);
    expect(result.stdout).toMatch(/^ROOT: /m);
  });

  it('歯4: --root を渡すと、実効 ROOT がその上書き先として出力に出る', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-root-override-cli-'));
    try {
      const result = runCli(['status', '--root', tmp]);
      const resolvedTmp = path.resolve(tmp);
      expect(result.stdout).toContain(`ROOT: ${resolvedTmp}`);
      expect(result.stdout).toContain('--root で上書き');
      expect(result.stdout).toContain(`既定は ${REPO_ROOT}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('歯3: 存在しない --root は fail-closed になる（exit 非0）', () => {
    const result = runCli(['status', '--root', '/nonexistent/mutate-root-override-cli-probe']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('存在しない');
  });

  it('歯3: ディレクトリでない --root は fail-closed になる（exit 非0）', () => {
    const result = runCli(['status', '--root', __filename]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('ディレクトリでない');
  });

  it('歯1: --root <path> を渡すと apply/restore が MARKER_PATH / BACKUP_DIR も含めてそのツリーを使う', () => {
    const tmp = makeTmpGitRepo();
    try {
      const specPath = path.join(tmp, 'spec.json');
      fs.writeFileSync(
        specPath,
        JSON.stringify({
          id: 'root-override-probe',
          file: 'target.txt',
          from: 'hello',
          to: 'HELLO',
          expect: 1,
          target: null,
        }),
      );

      const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
      expect(applyResult.status).toBe(0);

      // ROOT: target.txt がこのツリーの中で実際に書き換わっている。
      expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('HELLO world\n');
      // MARKER_PATH: 印がこのツリーの直下に置かれている。
      expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
      // BACKUP_DIR: 控えがこのツリーの .mutation-testing/backups の下に置かれている。
      expect(
        fs.existsSync(path.join(tmp, '.mutation-testing', 'backups', 'root-override-probe.bak')),
      ).toBe(true);

      // 実リポジトリ側には何も漏れていないこと（対象の取り違えが起きていないこと）。
      expect(fs.existsSync(path.join(REPO_ROOT, 'MUTATION-IN-PROGRESS.json'))).toBe(false);

      const restoreResult = runCli(['restore', '--root', tmp]);
      expect(restoreResult.status).toBe(0);
      expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('hello world\n');
      expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
