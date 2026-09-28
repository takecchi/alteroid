import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { PendingApproval } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #2007。`FsJobStore.updateApproval` は、排他区間（`withPathLock`）の中で現在の
 * 承認の行を読み直し、`mutate` の結果を書く。`mutate` が `null` を返したら何も書かない。
 */
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

  it('行が無ければ null を返し、mutate を呼ばない', async () => {
    const stores = createFsStores(root);
    let called = false;
    const result = await stores.jobs.updateApproval('nope', (current) => {
      called = true;
      return current;
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('mutate の結果を書いて返し、読み直すと書いた値が在る', async () => {
    const stores = createFsStores(root);
    await stores.jobs.putApproval(APPROVAL);
    const result = await stores.jobs.updateApproval('ap-1', (current) => ({
      ...current,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: 'よい',
    }));
    expect(result?.answer).toBe('よい');
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
  });

  it('mutate が null を返したら何も書かず null を返す', async () => {
    const stores = createFsStores(root);
    await stores.jobs.putApproval(APPROVAL);
    const result = await stores.jobs.updateApproval('ap-1', () => null);
    expect(result).toBeNull();
    expect(await stores.jobs.getApproval('ap-1')).toEqual(APPROVAL);
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
