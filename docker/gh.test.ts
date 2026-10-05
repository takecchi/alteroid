/**
 * `docker/gh`（鍵の読み場所を1つ挟む `gh` のシム）を固定する。
 *
 * release-prod の起動を止める門は外した（#2884。確認は `bash-release-prod-guard.ts` が持つ）。
 *
 * **本物の `gh` にも、本物の資格（`/run/alteroid/credentials/`）にも一切触らない。**
 * `ALTEROID_GH_REAL_BIN` で「本物の gh」をテスト用の偽物に差し替え、
 * `ALTEROID_CREDENTIAL_DIR` は使い捨ての一時ディレクトリへ向ける。値はすべてダミー文字列で、
 * 環境は `process.env` を継がずに組む（`execFileSync` は `env` を渡すと丸ごと置き換える）。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gh');

describe('鍵の読み込み', () => {
  it('ALTEROID_CREDENTIAL_DIR のファイルから GH_TOKEN を読み、本物の gh（この場合は偽物）へ渡す', () => {
    const root = makeTempDirSync('docker-gh-cred-test.');
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

describe('鍵の削除が走行中の gh へ届く（2026-10-06）', () => {
  /** 本物の gh の代わりに、GH_TOKEN / GITHUB_TOKEN が見えているかを出す偽物を置く。 */
  function setup(label: string): { root: string; fakeGh: string; credDir: string } {
    const root = makeTempDirSync(`docker-gh-removal-${label}.`);
    const fakeGh = join(root, 'fake-real-gh');
    writeFileSync(
      fakeGh,
      [
        '#!/bin/sh',
        'printf "GH_TOKEN_SEEN:%s\\n" "${GH_TOKEN:-<unset>}"',
        'printf "GITHUB_TOKEN_SEEN:%s\\n" "${GITHUB_TOKEN:-<unset>}"',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(fakeGh, 0o755);
    const credDir = join(root, 'creds');
    mkdirSync(credDir, { recursive: true });
    return { root, fakeGh, credDir };
  }

  it('所在（ALTEROID_GH_TOKEN_FILE）が明示されていてファイルが無いなら、起動時に凍った GH_TOKEN を捨てる', () => {
    const { root, fakeGh, credDir } = setup('missing');
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      ALTEROID_GH_REAL_BIN: fakeGh,
      ALTEROID_CREDENTIAL_DIR: credDir,
      ALTEROID_GH_TOKEN_FILE: join(credDir, 'GH_TOKEN'), // ファイルは置かない（外された）
      ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
      GH_TOKEN: 'dummy-frozen-at-spawn',
    };
    const stdout = execFileSync(SCRIPT, ['auth', 'status'], { env, encoding: 'utf8' });
    expect(stdout).toContain('GH_TOKEN_SEEN:<unset>');
  });

  it('所在が明示されていてファイルが空でも捨てる（空を export しない）', () => {
    const { root, fakeGh, credDir } = setup('empty');
    writeFileSync(join(credDir, 'GH_TOKEN'), '');
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      ALTEROID_GH_REAL_BIN: fakeGh,
      ALTEROID_CREDENTIAL_DIR: credDir,
      ALTEROID_GH_TOKEN_FILE: join(credDir, 'GH_TOKEN'),
      ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
      GH_TOKEN: 'dummy-frozen-at-spawn',
    };
    const stdout = execFileSync(SCRIPT, ['auth', 'status'], { env, encoding: 'utf8' });
    expect(stdout).toContain('GH_TOKEN_SEEN:<unset>');
  });

  it('名前ごとに見る: GH_TOKEN だけ外されても、ファイルが在る GITHUB_TOKEN は新しい値で届く', () => {
    const { root, fakeGh, credDir } = setup('per-name');
    writeFileSync(join(credDir, 'GITHUB_TOKEN'), 'dummy-new-github-token');
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      ALTEROID_GH_REAL_BIN: fakeGh,
      ALTEROID_CREDENTIAL_DIR: credDir,
      ALTEROID_GH_TOKEN_FILE: join(credDir, 'GH_TOKEN'),
      ALTEROID_GITHUB_TOKEN_FILE: join(credDir, 'GITHUB_TOKEN'),
      ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
      GH_TOKEN: 'dummy-frozen-at-spawn',
      GITHUB_TOKEN: 'dummy-old-github-token',
    };
    const stdout = execFileSync(SCRIPT, ['auth', 'status'], { env, encoding: 'utf8' });
    expect(stdout).toContain('GH_TOKEN_SEEN:<unset>');
    expect(stdout).toContain('GITHUB_TOKEN_SEEN:dummy-new-github-token');
  });

  it('所在が明示されていない層（ファイル置き場が無いクローン側など）では、env の GH_TOKEN を消さない', () => {
    const { root, fakeGh, credDir } = setup('no-location');
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      ALTEROID_GH_REAL_BIN: fakeGh,
      ALTEROID_CREDENTIAL_DIR: credDir, // ファイルは無い。ALTEROID_GH_TOKEN_FILE も置かない
      ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
      GH_TOKEN: 'dummy-from-env-only',
    };
    const stdout = execFileSync(SCRIPT, ['auth', 'status'], { env, encoding: 'utf8' });
    expect(stdout).toContain('GH_TOKEN_SEEN:dummy-from-env-only');
  });
});

describe('release-prod の起動は、このシムでは止めない（#2884）', () => {
  it('どの uid でも、本物の gh が同じ引数で呼ばれる（確認は PreToolUse の側が持つ）', () => {
    const root = makeTempDirSync('docker-gh-no-gate-test.');
    const fakeGh = join(root, 'fake-real-gh');
    writeFileSync(
      fakeGh,
      ['#!/bin/sh', 'printf "FAKE-GH-CALLED:%s\\n" "$*"', 'exit 0', ''].join('\n'),
    );
    chmodSync(fakeGh, 0o755);
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      ALTEROID_GH_REAL_BIN: fakeGh,
      ALTEROID_CREDENTIAL_DIR: join(root, 'creds-unused'),
      ALTEROID_PROFILE_FILE: join(root, 'no-such-profile.sh'),
      ALTEROID_RUNNER_CHILD_UID: String(process.getuid?.() ?? 0),
    };
    const stdout = execFileSync(SCRIPT, ['workflow', 'run', 'release-prod.yml'], {
      env,
      encoding: 'utf8',
    });
    expect(stdout).toContain('FAKE-GH-CALLED:workflow run release-prod.yml');
  });
});
