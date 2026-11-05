import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { PendingApproval } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

// 行が無い・書いた値が読み戻る・mutate が null のときの契約は `verifyJobStoreContract`（job-store-contract.test.ts）。ここは fs の JSON ファイルにしかない期待だけを持つ。
describe('FsJobStore.updateApproval（issue #2007）', () => {
  let root: string;

  const APPROVAL: PendingApproval = {
    id: 'ap-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    question: '本番に出してよいか',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  it('壊れた承認待ちの行は、書く回にも消さない（#1928 の持ち回り）', async () => {
    const stores = createFsStores(root);
    await stores.jobs.putApproval(APPROVAL);
    const path = join(root, 'jobs', 'jobs.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { approvals: unknown[] };
    raw.approvals.push({ id: 'ap-bad', nope: true });
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);

    await captureStderr(async () => {
      await stores.jobs.updateApproval('ap-1', (current) => ({ ...current, answer: 'よい' }));
    });

    const after = JSON.parse(await readFile(path, 'utf8')) as { approvals: { id?: string }[] };
    expect(after.approvals.map((row) => row.id).sort()).toEqual(['ap-1', 'ap-bad']);
  });
});
