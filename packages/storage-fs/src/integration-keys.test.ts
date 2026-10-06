import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyIntegrationKeyStoreContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('IntegrationKeyStore（fs 実装）', () => {
  it('3実装共通の契約を満たす', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await expect(
      verifyIntegrationKeyStoreContract(stores.integrationKeys),
    ).resolves.toBeUndefined();
  });

  it('0600 で書き、読めない行は消さずに持ち回る（欄名だけを stderr へ）', async () => {
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    const file = join(root, 'auth', 'integration-keys.json');
    await mkdir(join(root, 'auth'), { recursive: true });
    await writeFile(file, JSON.stringify({ keys: [{ id: 'broken', source: 'BAD SOURCE' }] }));
    await stores.integrationKeys.putIntegrationKey({
      id: 'k1',
      name: 'ci',
      source: 'ci',
      sha256: 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'operator',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      maxBodyBytes: null,
      ratePerMinute: null,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const body = JSON.parse(await readFile(file, 'utf8')) as { keys: { id: string }[] };
    expect(body.keys.map((row) => row.id).sort()).toEqual(['broken', 'k1']);
    expect((await stores.integrationKeys.listIntegrationKeys()).map((row) => row.id)).toEqual([
      'k1',
    ]);
  });
});
