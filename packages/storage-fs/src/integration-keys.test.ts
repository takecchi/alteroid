import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, verifyIntegrationKeyStoreContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

async function quiet<T>(body: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await captureStderr(async () => {
    result = await body();
  });
  return result as T;
}

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

  it('読めない行は listUnreadable で id と不正な欄名だけを返し、id を指して消せる（issue #3216）', async () => {
    const FAKE = 'FAKE_SECRET_VALUE_3216';
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    const file = join(root, 'auth', 'integration-keys.json');
    await mkdir(join(root, 'auth'), { recursive: true });
    const bad = { id: 'bad', name: FAKE, source: 'BAD SOURCE' };
    const idless = { name: FAKE };
    await writeFile(file, JSON.stringify({ keys: [bad, { id: 'bad-2', name: FAKE }, idless] }));
    const store = stores.integrationKeys;
    await store.putIntegrationKey({
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
    const rawKeys = async () =>
      (JSON.parse(await readFile(file, 'utf8')) as { keys: { id?: string }[] }).keys;

    const unreadable = await quiet(async () => store.listUnreadableIntegrationKeys());
    expect(unreadable.map((row) => row.id)).toEqual(['bad', 'bad-2', undefined]);
    expect(unreadable[0]?.reason).toMatch(/^不正な欄: source,/);
    expect(JSON.stringify(unreadable)).not.toContain(FAKE);

    const before = await readFile(file, 'utf8');
    let called = false;
    for (const wrong of ['nope', 'k1', 'bad\u0000']) {
      const result = await quiet(async () =>
        store.removeUnreadableIntegrationKeys(['bad', wrong], {
          beforeRemove: async () => {
            called = true;
          },
        }),
      );
      expect(result).toEqual({ kind: 'unknown', count: 1 });
    }
    expect(called).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(before);

    await expect(
      quiet(async () =>
        store.removeUnreadableIntegrationKeys(['bad'], {
          beforeRemove: async () => {
            throw new Error('journal down');
          },
        }),
      ),
    ).rejects.toThrow('journal down');
    expect(await readFile(file, 'utf8')).toBe(before);

    const order: string[] = [];
    const removed = await quiet(async () =>
      store.removeUnreadableIntegrationKeys(['bad', 'bad'], {
        beforeRemove: async (ids) => {
          order.push(
            `before:${ids.join(',')}:${(await rawKeys()).some((row) => row.id === 'bad')}`,
          );
        },
      }),
    );
    expect(removed).toEqual({ kind: 'removed', ids: ['bad'] });
    expect(order).toEqual(['before:bad:true']);
    const left = await rawKeys();
    expect(left.map((row) => row.id)).toEqual(['k1', 'bad-2', undefined]);
    expect((await store.getIntegrationKey('k1'))?.id).toBe('k1');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
