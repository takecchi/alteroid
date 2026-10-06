import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, verifyApprovalConversationFilterContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('承認の会話の絞りの契約（#3290）— fs', () => {
  it('会話の絞りが、絞らない結果を一致で絞ったものと同じ', async () => {
    const root = await makeTempDir('alteroid-test-');
    await verifyApprovalConversationFilterContract(createFsStores(root));
  });

  it('会話で絞った unreadable は、生の conversationId が一致する行だけ。絞らない呼びは全件（#3319）', async () => {
    const root = await makeTempDir('alteroid-test-');
    await mkdir(join(root, 'jobs'), { recursive: true });
    const bad = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      createdAt: 'not-a-date',
      question: 'x',
      ...extra,
    });
    const rows = [
      bad('bad-x', { conversationId: 'conv-x' }),
      bad('bad-x-settled', { conversationId: 'conv-x', answeredAt: '2026-01-01T00:00:00.000Z' }),
      bad('bad-y', { conversationId: 'conv-y' }),
      bad('bad-none'),
      bad('bad-num', { conversationId: 5 }),
      'not-an-object',
    ];
    await writeFile(join(root, 'jobs', 'jobs.json'), JSON.stringify({ jobs: [], approvals: rows }));
    const stores = createFsStores(root);
    await captureStderr(async () => {
      const ids = async (o: { pendingOnly?: boolean; conversationId?: string }) =>
        (await stores.jobs.listApprovals(o)).unreadable.map((u) => u.id);
      expect(await ids({ conversationId: 'conv-x' })).toEqual(['bad-x', 'bad-x-settled']);
      expect(await ids({ conversationId: 'conv-x', pendingOnly: true })).toEqual(['bad-x']);
      expect(await ids({ conversationId: 'conv-y' })).toEqual(['bad-y']);
      expect(await ids({ conversationId: 'conv-none' })).toEqual([]);
      expect(await ids({})).toEqual([
        'bad-x',
        'bad-x-settled',
        'bad-y',
        'bad-none',
        'bad-num',
        undefined,
      ]);
    });
  });
});
