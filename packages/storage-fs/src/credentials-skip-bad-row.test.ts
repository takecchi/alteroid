import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1740。`FsCredentialVaultStore.#read()` は以前 `fileSchema.parse` で
 * `credentials.json` の配列全体を1回に検査していたため、1行でも名前が
 * `CREDENTIAL_NAME`（`/^[A-Z][A-Z0-9_]*$/`）に合わないと `list()` が丸ごと
 * 例外を投げ、正しい行（`GH_TOKEN` 等）まで読めなくなっていた。`put()` も
 * `#read()` を通るので、直すための書き込みも同じ理由で失敗しえた。
 *
 * ここでは pg 版が元から行っている「その行だけを飛ばし、残りは返す」に fs 版を
 * そろえたことを確かめる。ダミー値のみを使う（本物のトークンは使わない）。
 */
describe('FsCredentialVaultStore — 不正な1行を読み飛ばす（issue #1740）', () => {
  let root: string;
  let credentialsPath: string;

  const FAKE_GOOD_VALUE = 'ghp_FAKEFAKE1111111111111111111111111111';
  const FAKE_BAD_VALUE = 'ghp_FAKEFAKE2222222222222222222222222222';
  // CREDENTIAL_NAME（/^[A-Z][A-Z0-9_]*$/）に合わない名前 —— 人間が手で書いた想定。
  const BAD_NAME = '../../etc/bad-name';

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    credentialsPath = join(root, 'credentials.json');
  });

  /** `credentials.json` を、人間が手で書いた想定の生の JSON で直接作る。 */
  async function writeRawCredentialsFile(): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          credentials: [
            {
              name: 'GH_TOKEN',
              value: FAKE_GOOD_VALUE,
              updatedAt: '2026-01-01T00:00:00.000Z',
              scope: 'all',
              secret: true,
            },
            {
              name: BAD_NAME,
              value: FAKE_BAD_VALUE,
              updatedAt: '2026-01-01T00:00:00.000Z',
              scope: 'all',
              secret: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }

  it('list() は不正な行を飛ばし、正しい行だけを返す（main では例外で赤）', async () => {
    await writeRawCredentialsFile();
    const stores = createFsStores(root);

    const rows = await stores.credentials.list();

    expect(rows.map((row) => row.name)).toEqual(['GH_TOKEN']);
    expect(rows[0]?.value).toBe(FAKE_GOOD_VALUE);
  });

  it('跡: 飛ばした行を stderr へ1行出す。値は絶対に含めない', async () => {
    await writeRawCredentialsFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.credentials.list();
    });
    const joined = lines.join('');

    // 何行目かと、名前は載る。
    expect(joined).toContain(BAD_NAME);
    // **値は絶対に出ない**（正しい行の値・不正な行の値のどちらも）。
    expect(joined).not.toContain(FAKE_GOOD_VALUE);
    expect(joined).not.toContain(FAKE_BAD_VALUE);
  });

  it('put() は投げない。書いた後のファイルに不正な行が元の形のまま残っている', async () => {
    await writeRawCredentialsFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(
        stores.credentials.put([{ name: 'NEW_KEY', value: 'ghp_FAKEFAKE3333333333333333333333333333' }]),
      ).resolves.toBeDefined();
    });

    const raw = await readFile(credentialsPath, 'utf8');
    const parsed = JSON.parse(raw) as { credentials: unknown[] };
    const badRow = parsed.credentials.find(
      (row) => typeof row === 'object' && row !== null && (row as { name?: unknown }).name === BAD_NAME,
    );

    // **元の形のまま**——書き換えられず、消えてもいない。
    expect(badRow).toEqual({
      name: BAD_NAME,
      value: FAKE_BAD_VALUE,
      updatedAt: '2026-01-01T00:00:00.000Z',
      scope: 'all',
      secret: true,
    });

    // 正しく書いた行（既存 + 新規）は普通に読める。
    const rows = await stores.credentials.list();
    expect(rows.map((row) => row.name).sort()).toEqual(['GH_TOKEN', 'NEW_KEY']);
  });
});
