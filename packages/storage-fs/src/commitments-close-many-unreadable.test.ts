import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * 読めない行の id を `closeMany()` に渡したときの結果は、`close()`（issue #2148 で
 * fs も読めない行を閉じられるようになった）と揃っているべき。pg は `close()` も
 * `closeMany()` も読めない行を閉じる（対は
 * `packages/storage-pg/src/commitments-close-many-unreadable.test.ts`）。fs の
 * `closeMany()` だけが `file.entries` しか見ず、読めない行は `[]`（閉じていない）になる。
 */
async function storesWithBadRow(): Promise<ReturnType<typeof createFsStores>> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.commitments.open({
    id: 'seed',
    at: '2026-09-02T00:00:00.000Z',
    origin: 'self',
    body: '正常な行',
  });
  const path = join(root, 'jobs', 'commitments.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
  raw.commitments.push({ id: 'broken' });
  await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
  return stores;
}

describe('CommitmentStore.closeMany() と読めない行（fs）', () => {
  it('close() が閉じられる読めない行は closeMany() でも閉じられ、その id が返る', async () => {
    const stores = await storesWithBadRow();
    const closed = await stores.commitments.closeMany(
      ['broken'],
      '2026-09-03T00:00:00.000Z',
      '閉じた',
      'human',
    );
    expect(closed).toEqual(['broken']);
  });

  it('正常な行と一緒に渡しても両方閉じ、2度目は閉じていないので [] を返す（close() と同じ）', async () => {
    const stores = await storesWithBadRow();
    const first = await stores.commitments.closeMany(
      ['broken', 'seed', 'broken'],
      '2026-09-03T00:00:00.000Z',
      '閉じた',
      'human',
    );
    expect(first.sort()).toEqual(['broken', 'seed']);
    const second = await stores.commitments.closeMany(
      ['broken', 'seed'],
      '2026-09-04T00:00:00.000Z',
      '閉じた',
      'human',
    );
    expect(second).toEqual([]);
  });
});
