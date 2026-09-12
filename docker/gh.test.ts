/**
 * `docker/gh`（release-prod の起動を止める門を持つ `gh` シム）を固定する。
 *
 * **本物の `gh` にも、本物の資格（`/run/alteroid/credentials/`）にも一切触らない。**
 * `ALTEROID_GH_REAL_BIN` で「本物の gh」をテスト用の偽物に差し替え、
 * `ALTEROID_CREDENTIAL_DIR` は毎回使い捨ての一時ディレクトリへ向ける
 * （`ALTEROID_CREDENTIAL_DIR` を明示せずに実行すると既定の `/run/alteroid/credentials`
 * を読みに行ってしまうため、**このファイルのすべてのテストで必ず明示的に渡す**）。
 * 値はすべてダミー文字列で、実物の鍵は一度も現れない。
 *
 * 環境も `process.env` を継いで渡さない —— 呼び出しごとに必要な変数だけを含む
 * 独立した env オブジェクトを組み立てる（`execFileSync` は `env` を渡すと
 * **丸ごと置き換える**。マージではない）。これにより、この実行環境に本物の
 * `GH_TOKEN` 等が乗っていても、子プロセスには一切継承されない。
 *
 * **「弾かれるべきもの」と「弾かれてはいけないもの」を必ず対で置く**（依頼者の
 * 指示）。前例は `.github/scripts/reflect-release-prod.sh` を固定する
 * `reflect-release-prod.test.ts`（本物の CLI を fake CLI に差し替えて実測する型）。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gh');

/** 実行中のテストプロセス自身の uid。「runner に起こされた子」を模すのに使う。 */
const OWN_UID = String(process.getuid?.() ?? 0);
/** 実際の uid と衝突しない値。「クローン（デーモン側）」を模すのに使う。 */
const OTHER_UID = '999999';

type Result = { exitCode: number; stdout: string; stderr: string };

/**
 * 使い捨ての一時ディレクトリを1つ作り、その中に「偽の本物 gh」を置く。
 * 偽物は呼ばれた引数をそのまま1行 `FAKE-GH-CALLED:` として stdout へ出すだけ
 * （実際に呼ばれたかどうかを、この文字列の有無で判定する）。
 */
function setupFakeRealGh(root: string): string {
  const fakeGh = join(root, 'fake-real-gh');
  writeFileSync(
    fakeGh,
    ['#!/bin/sh', 'printf "FAKE-GH-CALLED:%s\\n" "$*"', 'exit 0', ''].join('\n'),
  );
  chmodSync(fakeGh, 0o755);
  return fakeGh;
}

type RunOptions = {
  /** `ALTEROID_RUNNER_CHILD_UID` に置く値。省略すると変数そのものを渡さない（未設定＝fail-open側）。 */
  childUid?: string;
  /** 追加で渡す env（クレデンシャルのテストで使う）。 */
  extraEnv?: Record<string, string>;
};

/** `docker/gh` を、本物には一切触れない env で実行する。 */
function runGh(args: string[], options: RunOptions = {}): Result & { fakeGhPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'docker-gh-test.'));
  const fakeGh = setupFakeRealGh(root);
  const credDir = join(root, 'credentials-unused'); // 存在しなくてよい（[-r] が false になるだけ）

  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    ALTEROID_GH_REAL_BIN: fakeGh,
    // **既定の /run/alteroid/credentials へ絶対に落ちないようにする。**
    ALTEROID_CREDENTIAL_DIR: credDir,
    // 既定の /run/alteroid/profile/profile.sh にも落ちないようにする。
    ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
    ...(options.childUid === undefined ? {} : { ALTEROID_RUNNER_CHILD_UID: options.childUid }),
    ...options.extraEnv,
  };

  let exitCode = 0;
  let stdout: string;
  let stderr = '';
  try {
    stdout = execFileSync(SCRIPT, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
  }
  return { exitCode, stdout, stderr, fakeGhPath: fakeGh };
}

describe('マネージャー・作業者の層（uid が ALTEROID_RUNNER_CHILD_UID と一致）', () => {
  it.each([
    ['gh workflow run release-prod.yml', ['workflow', 'run', 'release-prod.yml']],
    [
      'gh workflow run .github/workflows/release-prod.yml --repo o/r（パス形）',
      ['workflow', 'run', '.github/workflows/release-prod.yml', '--repo', 'o/r'],
    ],
    [
      'gh api ... /actions/workflows/release-prod.yml/dispatches',
      ['api', '-X', 'POST', 'repos/o/r/actions/workflows/release-prod.yml/dispatches', '-f', 'ref=main'],
    ],
  ])('%s は弾かれる（本物の gh は呼ばれない・非0で終わる）', (_label, args) => {
    const r = runGh(args, { childUid: OWN_UID });

    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('FAKE-GH-CALLED');
    expect(r.stderr).toContain('release-prod');
    expect(r.stderr).toContain('止めた');
  });

  it.each([
    ['gh workflow run ci.yml（別のワークフロー）', ['workflow', 'run', 'ci.yml']],
    ['gh workflow run update-claude-sdk.yml（別のワークフロー）', ['workflow', 'run', 'update-claude-sdk.yml']],
    [
      'gh api ... /actions/workflows/ci.yml/dispatches（別のワークフロー）',
      ['api', '-X', 'POST', 'repos/o/r/actions/workflows/ci.yml/dispatches', '-f', 'ref=main'],
    ],
    ['gh pr create（無関係な操作）', ['pr', 'create', '--title', 'x', '--body', 'y']],
    ['gh issue view（無関係な操作）', ['issue', 'view', '5']],
    [
      'gh run list --workflow=release-prod.yml（読み取り専用。起動ではない）',
      ['run', 'list', '--workflow=release-prod.yml', '--limit', '10'],
    ],
  ])(
    '%s は弾かれない（本物の gh が同じ引数で呼ばれ、終了コードは本物のものを引き継ぐ）',
    (_label, args) => {
      const r = runGh(args, { childUid: OWN_UID });

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`FAKE-GH-CALLED:${args.join(' ')}`);
    },
  );
});

describe('クローンの層（uid が ALTEROID_RUNNER_CHILD_UID と一致しない）', () => {
  it('release-prod を起動する形でも、この門には当たらない（クローンの手動配備を塞がない）', () => {
    const r = runGh(['workflow', 'run', 'release-prod.yml'], { childUid: OTHER_UID });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('FAKE-GH-CALLED:workflow run release-prod.yml');
  });
});

describe('ALTEROID_RUNNER_CHILD_UID が読めないとき（fail-open）', () => {
  it('見分けがつかない側に倒して、門を掛けない', () => {
    const r = runGh(['workflow', 'run', 'release-prod.yml'], {});

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('FAKE-GH-CALLED:workflow run release-prod.yml');
  });
});

describe('鍵の読み込み（門を足す前からの挙動。壊していないことの回帰）', () => {
  it('ALTEROID_CREDENTIAL_DIR のファイルから GH_TOKEN を読み、本物の gh（この場合は偽物）へ渡す', () => {
    const root = mkdtempSync(join(tmpdir(), 'docker-gh-cred-test.'));
    const fakeGh = join(root, 'fake-real-gh');
    // GH_TOKEN が実際に export されて渡ったかを、偽物の中で確かめる。
    writeFileSync(
      fakeGh,
      ['#!/bin/sh', 'printf "GH_TOKEN_SEEN:%s\\n" "${GH_TOKEN:-<unset>}"', 'exit 0', ''].join('\n'),
    );
    chmodSync(fakeGh, 0o755);
    const credDir = join(root, 'creds');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, 'GH_TOKEN'), 'dummy-not-a-real-token-abc123');

    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      ALTEROID_GH_REAL_BIN: fakeGh,
      ALTEROID_CREDENTIAL_DIR: credDir,
      ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
    };
    const stdout = execFileSync(SCRIPT, ['auth', 'status'], { env, encoding: 'utf8' });

    expect(stdout).toContain('GH_TOKEN_SEEN:dummy-not-a-real-token-abc123');
  });
});
