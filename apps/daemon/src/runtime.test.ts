import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runtimeFilePath, writeRuntimeInfo } from './runtime.js';

/**
 * issue #1871。`state/daemon.json` の `token` は operator の資格そのもの
 * である（`auth.ts` の `isOperator` の doc）。**この token を提示できることが
 * `requireOperator` と `requireOwner` の両方を無条件に通す**（`app.ts` の
 * 該当ミドルウェア）ので、`~/.alteroid/state/credentials.json`
 * （`apps/cli/src/credentials.ts`）と同格か、それ以上に守るべき秘密である。
 *
 * `credentials.ts` の `persist()` は `writeFile(..., { mode: 0o600 })` に加えて
 * 明示の `chmod` まで足している（「一時ファイルの時点で 0600。rename 後に
 * 絞ると、その隙間で他人が読める」）。**`writeRuntimeInfo`（`runtime.ts`）には
 * その手当てが無い** — 素の `writeFile(path, json, 'utf8')` で、パーミッションは
 * プロセスの umask 任せになる。
 *
 * ここで固定したい保証は2つ。
 * 1. **新規作成**: 既定の umask（Linux の典型値 022）でも、書き上がった
 *    `daemon.json` は group/other から読めない。
 * 2. **既存ファイルの書き直し**: `writeFile` の `mode` オプションは、その
 *    ファイルが**新規作成のときだけ**効く（POSIX の `open()` は既存ファイルに
 *    `mode` を適用しない）。だから `mode: 0o600` を足すだけの直し方だと、
 *    過去のバグ入りの版が作った 0644 の `daemon.json` を次の起動が書き直しても
 *    パーミッションはそのまま——`persist()` が rename 前にも明示の `chmod` を
 *    足している理由と同じで、書いた後に必ず `chmod` を掛ける必要がある。
 */
describe('writeRuntimeInfo（daemon.json）のパーミッション（issue #1871）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alteroid-runtime-perm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('新規作成: umask が緩い環境でも、operator token を含む daemon.json を group/other へ読めるままにしない', async () => {
    const previousUmask = process.umask(0o022); // Linux の典型的な既定値を明示的に模す
    try {
      await writeRuntimeInfo(dir, {
        pid: 1234,
        port: 4517,
        startedAt: '2026-09-27T00:00:00.000Z',
        token: 'operator-secret-token-do-not-leak',
      });
    } finally {
      process.umask(previousUmask);
    }

    const info = await stat(join(dir, 'daemon.json'));
    // group/other に read/write/execute のいずれかのビットが立っていたら失格。
    expect(info.mode & 0o077).toBe(0);

    // 中身に秘密の token が書かれていること自体は仕様どおり（比較対象）。
    const raw = await readFile(join(dir, 'daemon.json'), 'utf8');
    expect(raw).toContain('operator-secret-token-do-not-leak');
  });

  it('既存ファイルの書き直し: 既に 0644 で在る daemon.json を書き直しても、パーミッションは 0600 まで絞られる', async () => {
    const path = runtimeFilePath(dir);
    // 直す前の版（またはこの直し以前に作られた版）が残した、group/other から
    // 読める古い daemon.json を模す。`writeFile` の `mode` は新規作成にしか
    // 効かないので、ここで明示的に緩いパーミッションを作っておく。
    await writeFile(path, '{}\n', { mode: 0o644 });
    await chmod(path, 0o644);
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o644);

    await writeRuntimeInfo(dir, {
      pid: 5678,
      port: 4518,
      startedAt: '2026-09-27T00:00:00.000Z',
      token: 'operator-secret-token-do-not-leak-2',
    });

    const after = await stat(path);
    expect(after.mode & 0o077).toBe(0);
  });
});
