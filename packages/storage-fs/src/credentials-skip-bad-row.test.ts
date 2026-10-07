import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsCredentialVaultStore — 不正な1行を読み飛ばす（issue #1740）', () => {
  let root: string;
  let credentialsPath: string;

  const FAKE_GOOD_VALUE = 'ghp_FAKEFAKE1111111111111111111111111111';
  const FAKE_BAD_VALUE = 'ghp_FAKEFAKE2222222222222222222222222222';
  const BAD_NAME = '../../etc/bad-name';

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    credentialsPath = join(root, 'credentials.json');
  });

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

    expect(joined).toContain(BAD_NAME);
    expect(joined).not.toContain(FAKE_GOOD_VALUE);
    expect(joined).not.toContain(FAKE_BAD_VALUE);
  });

  it('put() は投げない。書いた後のファイルに不正な行が元の形のまま残っている', async () => {
    await writeRawCredentialsFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(
        stores.credentials.put([
          { name: 'NEW_KEY', value: 'ghp_FAKEFAKE3333333333333333333333333333' },
        ]),
      ).resolves.toBeDefined();
    });

    const raw = await readFile(credentialsPath, 'utf8');
    const parsed = JSON.parse(raw) as { credentials: unknown[] };
    const badRow = parsed.credentials.find(
      (row) =>
        typeof row === 'object' && row !== null && (row as { name?: unknown }).name === BAD_NAME,
    );

    expect(badRow).toEqual({
      name: BAD_NAME,
      value: FAKE_BAD_VALUE,
      updatedAt: '2026-01-01T00:00:00.000Z',
      scope: 'all',
      secret: true,
    });

    const rows = await stores.credentials.list();
    expect(rows.map((row) => row.name).sort()).toEqual(['GH_TOKEN', 'NEW_KEY']);
  });

  it('put() は、書き込む名前と一致する不正な行を置き換える（別名・名前の取れない行はそのまま残す）', async () => {
    const FAKE_OTHER_VALUE = 'ghp_FAKEFAKE4444444444444444444444444444';
    const FAKE_UNNAMED_VALUE = 'ghp_FAKEFAKE5555555555555555555555555555';
    const FAKE_NEW_VALUE = 'ghp_FAKEFAKE6666666666666666666666666666';

    await mkdir(root, { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          credentials: [
            {
              name: 'GH_TOKEN',
              value: FAKE_BAD_VALUE,
              updatedAt: '2026-01-01T00:00:00.000Z',
              scope: 'not-a-real-scope',
              secret: true,
            },
            {
              name: 'OTHER_TOKEN',
              value: FAKE_OTHER_VALUE,
              updatedAt: '2026-01-01T00:00:00.000Z',
              scope: 'all',
              secret: true,
            },
            { value: FAKE_UNNAMED_VALUE, updatedAt: '2026-01-01T00:00:00.000Z', scope: 'all' },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(
        stores.credentials.put([{ name: 'GH_TOKEN', value: FAKE_NEW_VALUE }]),
      ).resolves.toBeDefined();
    });

    const raw = await readFile(credentialsPath, 'utf8');
    const parsed = JSON.parse(raw) as { credentials: unknown[] };
    const named = parsed.credentials as { name?: unknown }[];

    expect(named.filter((row) => row.name === 'GH_TOKEN')).toEqual([
      expect.objectContaining({ name: 'GH_TOKEN', value: FAKE_NEW_VALUE }),
    ]);
    expect(named.filter((row) => row.name === 'OTHER_TOKEN')).toEqual([
      expect.objectContaining({ name: 'OTHER_TOKEN', value: FAKE_OTHER_VALUE }),
    ]);
    expect(named.some((row) => row.name === undefined)).toBe(true);

    const lines = await captureStderr(async () => {
      const rows = await stores.credentials.list();
      expect(rows.map((row) => row.name).sort()).toEqual(['GH_TOKEN', 'OTHER_TOKEN']);
      expect(rows.find((row) => row.name === 'GH_TOKEN')?.value).toBe(FAKE_NEW_VALUE);
    });
    expect(lines.join('')).not.toContain('GH_TOKEN');
  });
});
