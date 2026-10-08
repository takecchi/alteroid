import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

let root: string;

beforeEach(async () => {
  root = await makeTempDir('alteroid-test-');
});

describe('評定のキーを持つ過去の行が読める（issue #2699）', () => {
  it('list() は appraisal 系のキーを持つ行を unreadable にせず返す', async () => {
    const stores = createFsStores(root);
    await stores.commitments.open({
      id: 'seed',
      at: '2026-09-01T00:00:00.000Z',
      origin: 'self',
      body: '正常な行',
    });
    const path = join(root, 'jobs', 'commitments.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
    raw.commitments.push({
      id: 'legacy',
      at: '2026-09-01T00:00:00.000Z',
      origin: 'self',
      body: '評定つきの過去の行',
      closedAt: '2026-09-02T00:00:00.000Z',
      closedReason: '済んだ',
      closedBy: 'clone',
      appraisal: 'good',
      appraisedAt: '2026-09-02T00:01:00.000Z',
      appraisedBy: 'human',
      appraisalReason: '理由',
      workKind: '実装',
    });
    await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');

    const fresh = createFsStores(root);
    const listed = await fresh.commitments.list({ includeClosed: true });
    expect(listed.unreadable).toEqual([]);
    expect(listed.entries.map((entry) => entry.id).sort()).toEqual(['legacy', 'seed']);
    expect((await fresh.commitments.get('legacy'))?.body).toBe('評定つきの過去の行');
  });
});
