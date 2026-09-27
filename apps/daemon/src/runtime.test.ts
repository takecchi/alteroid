import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { runtimeFilePath, writeRuntimeInfo } from './runtime.js';

/**
 * issue #1871。`state/daemon.json` の `token` は operator の資格そのもの
 * である（`auth.ts` の `isOperator` の doc）。**この token を提示できることが
 * `requireOperator` と `requireOwner` の両方を無条件に通す**（`app.ts` の
 * 該当ミドルウェア）ので、`~/.alteroid/state/credentials.json`
 * （`apps/cli/src/credentials.ts`）と同格か、それ以上に守るべき秘密である。
 *
 * `credentials.ts` の `persist()` は一時ファイルへ `writeFile(..., { mode: 0o600 })`
 * ＋明示の `chmod` で書いてから `rename` で本体へ切り替えている（「一時ファイルの
 * 時点で 0600。rename 後に絞ると、その隙間で他人が読める」）。直す前の
 * `writeRuntimeInfo`（`runtime.ts`）にはその手当てが無かった——素の
 * `writeFile(path, json, 'utf8')` で、パーミッションはプロセスの umask 任せに
 * なっていた。
 *
 * ここで固定したい保証は3つ。
 * 1. **新規作成**: 既定の umask（Linux の典型値 022）でも、書き上がった
 *    `daemon.json` は group/other から読めない。
 * 2. **既存ファイルの書き直し**: `writeFile` の `mode` オプションは、その
 *    ファイルが**新規作成のときだけ**効く（POSIX の `open()` は既存ファイルに
 *    `mode` を適用しない）。だから `mode: 0o600` を足すだけの直し方だと、
 *    過去のバグ入りの版が作った 0644 の `daemon.json` を次の起動が書き直しても
 *    パーミッションはそのまま——書いた後にパーミッションを絞り直す手当てが要る。
 * 3. **書き込みの途中に緩いモードの窓を作らない**: 既存ファイルを直接
 *    `writeFile` で上書きしてから `chmod` する形だと、その2手の間は
 *    「新しい token を含む中身」が「古い（緩い）パーミッション」のまま乗る。
 *    `writeRuntimeInfo` は `credentials.ts` の `persist()` と同じく一時ファイル
 *    ＋`rename` にしたので、そもそも `${path}.tmp` 以外の場所に緩いパーミッション
 *    の窓ができない（`rename` の完了後には tmp も残らない）。
 */
describe('writeRuntimeInfo（daemon.json）のパーミッション（issue #1871）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('alteroid-runtime-perm-');
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

  it('一時ファイル経由で書くので、書き終えた後に .tmp が残らない（緩いモードの窓を作らない実装であることの傍証）', async () => {
    await writeRuntimeInfo(dir, {
      pid: 9012,
      port: 4519,
      startedAt: '2026-09-27T00:00:00.000Z',
      token: 'operator-secret-token-do-not-leak-3',
    });

    const entries = await readdir(dir);
    expect(entries).toEqual(['daemon.json']);
  });
});
