import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  DEFAULT_ROOT,
  HarnessError,
  setRootOverride,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';
import {
  DELIVERY_BARREL_REL,
  DELIVERY_BARREL_SCAFFOLD_BEGIN,
  DELIVERY_BARREL_SCAFFOLD_BLOCK,
  DELIVERY_BARREL_SCAFFOLD_END,
  DELIVERY_FIXTURE_MODULE_BODY,
  DELIVERY_FIXTURE_MODULE_REL,
  findLeftoverDeliveryScaffold,
  formatLeftoverDeliveryScaffoldNotice,
  requireNoLeftoverDeliveryFixtureFiles,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

function runCli(args: string[]) {
  return spawnSync('node', [MUTATE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: mutateCliChildEnv(),
  });
}

function makeTmpGitRepo(): string {
  const dir = makeTempDirSync('mutate-delivery-scaffold-leftover-');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitChildEnv() });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    env: gitChildEnv(),
  });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env: gitChildEnv() });
  fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
  fs.mkdirSync(path.join(dir, 'packages/core/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, DELIVERY_BARREL_REL), 'export const already = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitChildEnv() });
  return dir;
}

const PLACEHOLDER_SPEC = {
  id: 'delivery-scaffold-leftover-probe',
  file: 'target.txt',
  from: 'hello',
  to: 'HELLO',
  expect: 1,
  target: null,
  mustFail: [
    'delivery-scaffold-leftover-probe はこの歯で judge を呼ばない（apply/restore のみを測る）',
  ],
};

function writeSpec(dir: string): string {
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(PLACEHOLDER_SPEC));
  return specPath;
}

function writeBothScaffold(dir: string) {
  fs.appendFileSync(path.join(dir, DELIVERY_BARREL_REL), DELIVERY_BARREL_SCAFFOLD_BLOCK);
  fs.writeFileSync(path.join(dir, DELIVERY_FIXTURE_MODULE_REL), DELIVERY_FIXTURE_MODULE_BODY);
}

function writeFixtureOnly(dir: string) {
  fs.writeFileSync(path.join(dir, DELIVERY_FIXTURE_MODULE_REL), DELIVERY_FIXTURE_MODULE_BODY);
}

function writeBarrelOnly(dir: string) {
  fs.appendFileSync(path.join(dir, DELIVERY_BARREL_REL), DELIVERY_BARREL_SCAFFOLD_BLOCK);
}

// 各 it は必ず `finally` で `DEFAULT_ROOT` へ戻す: `absPath` / `readRepoFile` が module scope の `ROOT` を見るため、他の it・describe を汚染しないように。

describe('mutate-selftest: findLeftoverDeliveryScaffold（純粋な検出）', () => {
  it('足場もフィクスチャも無ければ空配列', () => {
    const tmp = makeTempDirSync('delivery-scaffold-pure-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('barrel（packages/core/src/index.ts）そのものが無くても空配列（ENOENT を「足場無し」として飲み込む）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-pure-noindex-');
    try {
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('フィクスチャ本体だけ在れば1件（kind: fixture）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-pure-fixture-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeFixtureOnly(tmp);
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([
        { kind: 'fixture', path: DELIVERY_FIXTURE_MODULE_REL },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('barrel の re-export 行だけ在れば1件（kind: barrel）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-pure-barrel-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBarrelOnly(tmp);
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([
        { kind: 'barrel', path: DELIVERY_BARREL_REL },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('両方在れば2件、順序はフィクスチャ→barrel（元の requireNoLeftover…の判定順と同じ）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-pure-both-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBothScaffold(tmp);
      setRootOverride(tmp);
      expect(findLeftoverDeliveryScaffold()).toEqual([
        { kind: 'fixture', path: DELIVERY_FIXTURE_MODULE_REL },
        { kind: 'barrel', path: DELIVERY_BARREL_REL },
      ]);
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });
});

describe('mutate-selftest: requireNoLeftoverDeliveryFixtureFiles の文面は不変', () => {
  it('足場が無ければ何もしない（投げない）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-msg-none-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      setRootOverride(tmp);
      expect(() => requireNoLeftoverDeliveryFixtureFiles('delivery')).not.toThrow();
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('両方在るときの文面（逐語固定）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-msg-both-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBothScaffold(tmp);
      setRootOverride(tmp);
      expect(() => requireNoLeftoverDeliveryFixtureFiles('delivery')).toThrow(
        new RegExp(
          '^delivery: 前回の selftest が置き去りにした足場が在る。上書きしない。\\n' +
            '  - packages/core/src/mutation-selftest-delivery-fixture\\.ts（フィクスチャ本体）\\n' +
            '  - packages/core/src/index\\.ts（一時的な re-export 行が残っている）\\n' +
            '中身を確認してから手で消して、再実行すること。印（MUTATION-IN-PROGRESS\\.json）が' +
            '残っているなら、先にそちらを `mutate\\.mjs status` / `restore` で片付けること——' +
            'フィクスチャ本体を先に消すと復元先が無くなる。packages/core/src/index\\.ts は' +
            '「// ── mutation-testing selftest 用の一時的な足場（#1166 面1）ここから ──」から' +
            '「// ── mutation-testing selftest 用の一時的な足場（#1166 面1）ここまで ──」までの' +
            '行を削除すれば元に戻る（フィクスチャ本体 ' +
            'packages/core/src/mutation-selftest-delivery-fixture\\.ts も合わせて削除）。$',
        ),
      );
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('フィクスチャ本体だけのときは、その1行だけを名指しする（barrel の行は出ない）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-msg-fixture-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeFixtureOnly(tmp);
      setRootOverride(tmp);
      let thrown: unknown;
      try {
        requireNoLeftoverDeliveryFixtureFiles('delivery');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HarnessError);
      const message = (thrown as Error).message;
      expect(message).toContain(
        '  - packages/core/src/mutation-selftest-delivery-fixture.ts（フィクスチャ本体）\n',
      );
      expect(message).not.toContain('一時的な re-export 行が残っている');
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });

  it('barrel の re-export 行だけのときは、その1行だけを名指しする（フィクスチャの行は出ない）', () => {
    const tmp = makeTempDirSync('delivery-scaffold-msg-barrel-');
    try {
      fs.mkdirSync(path.join(tmp, 'packages/core/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'export const already = 1;\n');
      writeBarrelOnly(tmp);
      setRootOverride(tmp);
      let thrown: unknown;
      try {
        requireNoLeftoverDeliveryFixtureFiles('delivery');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HarnessError);
      const message = (thrown as Error).message;
      expect(message).toContain(
        '  - packages/core/src/index.ts（一時的な re-export 行が残っている）\n',
      );
      expect(message).not.toContain('フィクスチャ本体）');
    } finally {
      setRootOverride(DEFAULT_ROOT);
    }
  });
});

describe('mutate-selftest: formatLeftoverDeliveryScaffoldNotice', () => {
  it('見つからなければ null（cmdRestore はこれで「何も足さない」を判定する）', () => {
    expect(formatLeftoverDeliveryScaffoldNotice([])).toBeNull();
  });

  it('見つかった場合は、BEGIN/END の逐語と両方のパスを含む1つの文字列を返す', () => {
    const notice = formatLeftoverDeliveryScaffoldNotice([
      { kind: 'fixture', path: DELIVERY_FIXTURE_MODULE_REL },
      { kind: 'barrel', path: DELIVERY_BARREL_REL },
    ]);
    expect(notice).not.toBeNull();
    expect(notice as string).toContain(DELIVERY_FIXTURE_MODULE_REL);
    expect(notice as string).toContain(DELIVERY_BARREL_REL);
    expect(notice as string).toContain(DELIVERY_BARREL_SCAFFOLD_BEGIN);
    expect(notice as string).toContain(DELIVERY_BARREL_SCAFFOLD_END);
    // 「先に印を片付けること」は言わない: `restore` は既に成功しており、言うと印は解除済みなのに矛盾した案内になるため。
    expect(notice as string).not.toContain('先にそちらを');
  });
});

describe('mutate.mjs CLI: restore は成功した後、delivery の足場が残っていれば名指しする', () => {
  it('陽性対照（足場なし）: 復元元/後始末の行の後は1文字も増えない（末尾の改行1個のみ）', () => {
    const tmp = makeTmpGitRepo();
    const specPath = writeSpec(tmp);
    const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
    expect(applyResult.status).toBe(0);

    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);

    const stdout = restoreResult.stdout ?? '';
    const marker = '復元元: backup / 後始末: target が無いので後始末は不要（build exit=N/A）';
    const idx = stdout.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    expect(stdout.slice(idx)).toBe(`${marker}\n`);
  });

  it('足場が両方在るとき: 2ファイルを名指しし、外し方を出す', () => {
    const tmp = makeTmpGitRepo();
    writeBothScaffold(tmp);
    const specPath = writeSpec(tmp);
    const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
    expect(applyResult.status).toBe(0);

    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain(
      '復元元: backup / 後始末: target が無いので後始末は不要（build exit=N/A）',
    );
    expect(stdout).toContain('delivery: 前回の selftest が置き去りにした足場が残っている');
    expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
    expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
    expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_BEGIN);
    expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_END);

    expect(fs.existsSync(path.join(tmp, DELIVERY_FIXTURE_MODULE_REL))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'utf8')).toContain(
      DELIVERY_BARREL_SCAFFOLD_BEGIN,
    );
  });

  it('フィクスチャ本体だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepo();
    writeFixtureOnly(tmp);
    const specPath = writeSpec(tmp);
    runCli(['apply', '--spec', specPath, '--root', tmp]);
    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
    expect(stdout).not.toContain('一時的な re-export 行が残っている');
  });

  it('barrel の re-export 行だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepo();
    writeBarrelOnly(tmp);
    const specPath = writeSpec(tmp);
    runCli(['apply', '--spec', specPath, '--root', tmp]);
    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
    expect(stdout).not.toContain('フィクスチャ本体）');
  });
});

function makeTmpGitRepoWithScaffoldNoMarker(write: (dir: string) => void): string {
  const tmp = makeTmpGitRepo();
  write(tmp);
  return tmp;
}

function applyThenCorruptBackup(tmp: string): void {
  const specPath = writeSpec(tmp);
  const applyResult = runCli(['apply', '--spec', specPath, '--root', tmp]);
  expect(applyResult.status).toBe(0);
  const marker = JSON.parse(fs.readFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), 'utf8'));
  fs.writeFileSync(path.join(tmp, marker.backupPath), 'CORRUPTED\n');
}

describe('mutate.mjs CLI: restore が「印が無い」で失敗する場合も、足場が残っていれば名指しする（#1358 の限界を塞ぐ）', () => {
  it('陽性対照（印も足場も無い）: 出力は現行の main と逐語で同じ（足した文が1文字も出ない）', () => {
    const tmp = makeTmpGitRepo();
    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(1);
    const stdout = restoreResult.stdout ?? '';
    const idx = stdout.indexOf('── restore ──');
    expect(idx).toBeGreaterThan(-1);
    expect(stdout.slice(idx)).toBe('── restore ──\nエラー: 印が無い。\n');
  });

  it('印が無く、足場が両方在るとき: 「印が無い。」は残ったまま、名指しと外し方も出る', () => {
    const tmp = makeTmpGitRepoWithScaffoldNoMarker(writeBothScaffold);
    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(1);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain('エラー: 印が無い。');
    expect(stdout).toContain('delivery: 前回の selftest が置き去りにした足場が残っている');
    expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
    expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
    expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_BEGIN);
    expect(stdout).toContain(DELIVERY_BARREL_SCAFFOLD_END);
    expect(stdout).toContain('印は最初から無く、この restore は何も書き戻していない');
    expect(stdout).not.toContain('印の解除はここまでで完了している');

    expect(fs.existsSync(path.join(tmp, DELIVERY_FIXTURE_MODULE_REL))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, DELIVERY_BARREL_REL), 'utf8')).toContain(
      DELIVERY_BARREL_SCAFFOLD_BEGIN,
    );
  });

  it('印が無く、フィクスチャ本体だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepoWithScaffoldNoMarker(writeFixtureOnly);
    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(1);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain('エラー: 印が無い。');
    expect(stdout).toContain(`  - ${DELIVERY_FIXTURE_MODULE_REL}（フィクスチャ本体）`);
    expect(stdout).not.toContain('一時的な re-export 行が残っている');
  });

  it('印が無く、barrel の re-export 行だけ在るとき: その1件だけを名指しする', () => {
    const tmp = makeTmpGitRepoWithScaffoldNoMarker(writeBarrelOnly);
    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(1);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain('エラー: 印が無い。');
    expect(stdout).toContain(`  - ${DELIVERY_BARREL_REL}（一時的な re-export 行が残っている）`);
    expect(stdout).not.toContain('フィクスチャ本体）');
  });

  it('印は在るが restoreMutation が失敗する回（控えが汚染されている）は、足場が在っても名指しを出さない', () => {
    const tmp = makeTmpGitRepo();
    writeBothScaffold(tmp);
    applyThenCorruptBackup(tmp);

    const restoreResult = runCli(['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(1);
    const stdout = restoreResult.stdout ?? '';

    expect(stdout).toContain('控えの md5 が md5Pre と一致しない');
    expect(stdout).toContain('印は残す。');
    expect(stdout).not.toContain('delivery: 前回の selftest が置き去りにした足場が残っている');

    expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
  });
});
