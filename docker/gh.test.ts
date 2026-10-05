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
