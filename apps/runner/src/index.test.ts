import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokenSha256Of } from './index.js';

/**
 * **合鍵は「同じ値を両方に置くだけ」で済む。** そのうえで、走っている runner に
 * 素の鍵が残っていないこと（docs/architecture.md「制御面の保護」3枚目）を確かめる。
 *
 * 人間の手元を楽にした結果として守りが1枚落ちる、という取り違えがいちばん起きやすい
 * ところなので、**畳んだあとに何が残るか**をここで固定する。
 */
const run = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOKEN = 'the-shared-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

describe('tokenSha256Of', () => {
  it('素の合鍵だけが置かれていたら畳む（デーモンと同じ値を置けばよい）', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN: TOKEN })).toBe(TOKEN_SHA256);
  });

  it('sha256 を直に渡す形も引き続き通る', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256 })).toBe(TOKEN_SHA256);
  });

  it('両方あって一致しているなら通る', () => {
    expect(
      tokenSha256Of({ ALTEROID_RUNNER_TOKEN: TOKEN, ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256 }),
    ).toBe(TOKEN_SHA256);
  });

  it('食い違っていたら落とす（黙って片方を選ぶと 401 が出続けて噛み合わない）', () => {
    expect(() =>
      tokenSha256Of({ ALTEROID_RUNNER_TOKEN: TOKEN, ALTEROID_RUNNER_TOKEN_SHA256: 'deadbeef' }),
    ).toThrow(/食い違っている/);
  });

  it('空文字は未指定と同じに扱う', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN: '', ALTEROID_RUNNER_TOKEN_SHA256: '' })).toBe(
      undefined,
    );
  });
});

describe('器の起動スクリプト', () => {
  let dir: string;

  /** 呼ばれたことと、そのときの環境だけを吐く替え玉を置く。 */
  function fake(name: string, body: string): void {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alteroid-launch-'));
    // 偽の `node`。**exec された先が何を持っているか**を見たいだけなので、環境を
    // そのまま吐く（本物を起こす必要は無い）。
    fake('node', 'printf "%s\\n" "$@"\nenv');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function launch(name: string, env: NodeJS.ProcessEnv) {
    const { stdout } = await run('/bin/sh', [join(REPO_ROOT, 'docker', name)], {
      env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ...env },
    });
    return stdout;
  }

  /**
   * root で起こされた状況を作る。**特権が要る本物の降格は器（CI の image ジョブ）で
   * 見る**ので、ここで固定するのは「何を渡して降ろすか」だけである。
   */
  function pretendRoot(): void {
    fake('id', 'echo 0');
    fake('getent', 'echo "node:x:1000:1000::/home/node:/bin/bash"');
    fake('setpriv', 'printf "setpriv %s\\n" "$*"\nenv');
  }

  it('alteroid-runner: 素の合鍵を sha256 へ畳み、素の値は exec の先へ渡さない', async () => {
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN: TOKEN });

    expect(out).toContain(`ALTEROID_RUNNER_TOKEN_SHA256=${TOKEN_SHA256}`);
    // 「残っていない」ことが要点。`=` まで含めて見る（SHA256 の行に引っかからないため）
    expect(out).not.toContain(`ALTEROID_RUNNER_TOKEN=${TOKEN}`);
    expect(out.split('\n')).not.toContain(`ALTEROID_RUNNER_TOKEN=${TOKEN}`);
  });

  it('alteroid-runner: runner の実体を exec する', async () => {
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN: TOKEN });
    expect(out.split('\n')[0]).toBe('/app/apps/runner/dist/index.js');
  });

  it('alteroid-runner: 素の合鍵と sha256 が食い違っていたら起動しない', async () => {
    await expect(
      launch('alteroid-runner', {
        ALTEROID_RUNNER_TOKEN: TOKEN,
        ALTEROID_RUNNER_TOKEN_SHA256: 'deadbeef',
      }),
    ).rejects.toThrow(/食い違っている/);
  });

  it('alteroid-runner: sha256 だけの構成はそのまま通す', async () => {
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256 });
    expect(out).toContain(`ALTEROID_RUNNER_TOKEN_SHA256=${TOKEN_SHA256}`);
  });

  it('alteroidd: 非 root ならそのままデーモンを exec する', async () => {
    const out = await launch('alteroidd', {});
    expect(out.split('\n')[0]).toBe('/app/apps/daemon/dist/index.js');
  });

  it('alteroidd: root なら node へ降ろす', async () => {
    pretendRoot();
    const out = await launch('alteroidd', { HOME: '/root' });
    expect(out.split('\n')[0]).toBe(
      'setpriv --reuid=node --regid=node --init-groups node /app/apps/daemon/dist/index.js',
    );
  });

  it('alteroidd: 降ろすときは HOME も差し替える（root の home のままだと SDK が設定を書けない）', async () => {
    pretendRoot();
    const out = await launch('alteroidd', { HOME: '/root' });

    expect(out).toContain('HOME=/home/node');
    expect(out.split('\n')).not.toContain('HOME=/root');
    expect(out).toContain('USER=node');
    expect(out).toContain('LOGNAME=node');
  });
});
