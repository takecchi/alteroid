import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { runtimeFilePath, writeRuntimeInfo } from './runtime.js';

describe('writeRuntimeInfo（daemon.json）のパーミッション（issue #1871）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('alteroid-runtime-perm-');
  });

  it('新規作成: umask が緩い環境でも、operator token を含む daemon.json を group/other へ読めるままにしない', async () => {
    const previousUmask = process.umask(0o022);
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
    expect(info.mode & 0o077).toBe(0);

    const raw = await readFile(join(dir, 'daemon.json'), 'utf8');
    expect(raw).toContain('operator-secret-token-do-not-leak');
  });

  it('既存ファイルの書き直し: 既に 0644 で在る daemon.json を書き直しても、パーミッションは 0600 まで絞られる', async () => {
    const path = runtimeFilePath(dir);
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
