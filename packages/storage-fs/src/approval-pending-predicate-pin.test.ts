import type { PendingApproval } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

// 承認の「未決」の判定（`listApprovals({ pendingOnly: true })`）の、端の振る舞いを固定する。
// fs 実装もメモリ実装（core の testing.ts）も core の `approvalStateOf(...) === 'unanswered'` で見るので、同じ答えになる。
// postgres 実装は SQL（`isNull(answeredAt) and isNull(withdrawnAt)`）で別実装のため、ここでは固定しない（DB が要る）。

const AT = '2026-10-29T00:00:00.000Z';

describe('storage-fs jobs.ts listApprovals の未決の判定', () => {
  it('どちらも立っていない行だけが未決。回答済・取り下げ・両方立った行は載らない', async () => {
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    const rows: Record<string, Partial<PendingApproval>> = {
      neither: {},
      answered: { answeredAt: AT, answer: 'はい' },
      withdrawn: { withdrawnAt: AT, withdrawnReason: '不要' },
      both: { answeredAt: AT, answer: 'はい', withdrawnAt: AT, withdrawnReason: '不要' },
    };
    for (const [id, over] of Object.entries(rows)) {
      await stores.jobs.putApproval({ id, createdAt: AT, question: `q-${id}`, ...over });
    }
    const pending = (await stores.jobs.listApprovals({ pendingOnly: true })).entries.map(
      (a) => a.id,
    );
    expect(pending).toEqual(['neither']);
    const all = (await stores.jobs.listApprovals({ pendingOnly: false })).entries.map((a) => a.id);
    expect(all.sort()).toEqual(['answered', 'both', 'neither', 'withdrawn']);
  });
});
