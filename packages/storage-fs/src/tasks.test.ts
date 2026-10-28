import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UnreadableTaskError, verifyTaskStoreContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

async function plantBroken(path: string, id: string): Promise<void> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { tasks: unknown[] };
  raw.tasks.push({ rank: 1, task: { id, createdAt: '2026-01-01T00:00:00.000Z', status: 'weird' } });
  await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
}

describe('TaskStore（fs）', () => {
  it('3実装共通の契約を満たす（読めない行を含む）', async () => {
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    const path = join(root, 'jobs', 'tasks.json');
    await verifyTaskStoreContract(stores.tasks, {
      plantUnreadable: (id) => plantBroken(path, id),
    });
  });

  it('別のストアインスタンスから同じ並びが読める（ディスクが正本）', async () => {
    const root = await makeTempDir('alteroid-test-');
    const first = createFsStores(root);
    const now = '2026-01-01T00:00:00.000Z';
    for (const id of ['a', 'b']) {
      await first.tasks.add({
        id,
        createdAt: now,
        updatedAt: now,
        status: 'queued',
        origin: 'self',
        title: id,
        body: id,
      });
    }
    await first.tasks.move('b', { kind: 'front' });
    const second = createFsStores(root);
    expect((await second.tasks.list()).entries.map((task) => task.id)).toEqual(['b', 'a']);
  });

  it('読めない行は書き込みのたびに生の値のまま書き戻され、消えない', async () => {
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    const path = join(root, 'jobs', 'tasks.json');
    const now = '2026-01-01T00:00:00.000Z';
    await stores.tasks.add({
      id: 'ok',
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      origin: 'self',
      title: 't',
      body: 'b',
    });
    await plantBroken(path, 'broken');
    await stores.tasks.setStatus('ok', 'waiting', { by: 'clone', at: now });
    const raw = JSON.parse(await readFile(path, 'utf8')) as { tasks: { task: { id: string } }[] };
    expect(raw.tasks.map((row) => row.task.id).sort()).toEqual(['broken', 'ok']);
    await expect(stores.tasks.get('broken')).rejects.toBeInstanceOf(UnreadableTaskError);
  });
});
