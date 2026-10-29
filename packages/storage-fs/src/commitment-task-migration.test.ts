import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyCommitmentTaskMigrationContract } from '@alteroid/core';
import { describe, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

// 無ければ空の入れ物から始める: 読めない行を、他の行を開く前にも仕込めるように
async function appendRaw(
  dir: string,
  file: string,
  key: 'commitments' | 'tasks',
  row: unknown,
): Promise<void> {
  const path = join(dir, file);
  await mkdir(dir, { recursive: true });
  let raw: Record<string, unknown[]> = { [key]: [] };
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown[]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  raw[key] = [...(raw[key] ?? []), row];
  await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
}

describe('台帳→Task の移行（fs）', () => {
  it('3実装共通の契約を満たす（読めない行を含む）', async () => {
    await verifyCommitmentTaskMigrationContract(async () => {
      const root = await makeTempDir('alteroid-test-');
      const dir = join(root, 'jobs');
      return {
        stores: createFsStores(root),
        plantUnreadableCommitment: (id) =>
          appendRaw(dir, 'commitments.json', 'commitments', {
            id,
            at: '2026-09-02T00:00:00.000Z',
            origin: 'bogus',
            body: '壊れた本文',
          }),
        plantUnreadableTask: (id) =>
          appendRaw(dir, 'tasks.json', 'tasks', {
            rank: 1,
            task: { id, createdAt: '2026-01-01T00:00:00.000Z', status: 'weird' },
          }),
      };
    });
  });
});
