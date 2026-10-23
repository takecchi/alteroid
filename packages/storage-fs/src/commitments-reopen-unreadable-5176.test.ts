import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UnreadableCommitmentError } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('CommitmentStore.reopen() と読めない行（fs。#5176）', () => {
  it('読めない行は閉じていても UnreadableCommitmentError を投げ、ファイルを1バイトも書き換えない', async () => {
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
    await stores.commitments.close('broken', '2026-09-03T00:00:00.000Z', '閉じた', 'human');
    const before = await readFile(path, 'utf8');

    await expect(stores.commitments.reopen('broken')).rejects.toBeInstanceOf(
      UnreadableCommitmentError,
    );

    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
