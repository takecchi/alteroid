import { createMemoryStores, type JobStore, type PendingApproval } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * issue #2525: `PendingApproval.questions` / `selections` が3実装（インメモリ・fs・pg）で
 * 書いて読み戻せる。pg は `approvals.approval`（jsonb の本体）にそのまま入る——欄を足すだけで
 * 列は要らないが、**落とさず往復できること**は実装ごとに測る（`stripNulls` や zod の
 * `parse` が欄を削る変更が入ったときの歯）。
 */
describe('PendingApproval の questions / selections の往復（3実装。issue #2525）', () => {
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  const implementations: Array<[string, () => Promise<{ jobs: JobStore }>]> = [
    ['インメモリ実装', async () => createMemoryStores()],
    ['fs 実装', async () => createFsStores(await makeTempDir('alteroid-test-'))],
    [
      'pg 実装（PGlite）',
      async () => {
        const { db } = await createMigratedPglite();
        return createPgStoresFromDb(db);
      },
    ],
  ];

  const approval: PendingApproval = {
    id: 'ap-choices',
    createdAt: '2026-10-02T00:00:00.000Z',
    question: 'どうする',
    questions: [
      {
        id: 'target',
        prompt: 'デプロイ先',
        multiple: false,
        allowOther: true,
        options: [
          { id: 'railway', label: 'Railway', recommended: true, description: '既存の基盤' },
          { id: 'fly', label: 'Fly.io' },
        ],
      },
      {
        id: 'notify',
        prompt: '通知先',
        multiple: true,
        allowOther: false,
        options: [{ id: 'slack', label: 'Slack' }],
      },
    ],
  };

  it.each(implementations)(
    'questions は put/get/list で落ちない・selections は updateApproval で足せる——%s',
    async (_label, createStores) => {
      const { jobs } = await createStores();
      await jobs.putApproval(approval);

      expect(await jobs.getApproval('ap-choices')).toEqual(approval);
      expect((await jobs.listApprovals({ pendingOnly: true })).entries).toEqual([approval]);

      const selections = [
        { questionId: 'target', optionIds: ['railway'], other: 'ただし来週' },
        { questionId: 'notify', optionIds: [] },
      ];
      const answered = {
        ...approval,
        answeredAt: '2026-10-02T00:05:00.000Z',
        answer: 'Q1 デプロイ先: (a) Railway［推奨］ / その他: ただし来週\nQ2 通知先: 未回答',
        selections,
      };
      await jobs.updateApproval('ap-choices', () => answered);

      expect(await jobs.getApproval('ap-choices')).toEqual(answered);
      expect((await jobs.listApprovals()).entries).toEqual([answered]);
    },
  );

  it.each(implementations)(
    'questions の無い行は、読み戻しても questions / selections の欄が付かない——%s',
    async (_label, createStores) => {
      const { jobs } = await createStores();
      const plain: PendingApproval = {
        id: 'ap-plain',
        createdAt: '2026-10-02T00:00:00.000Z',
        question: '自由文だけ',
      };
      await jobs.putApproval(plain);
      const read = await jobs.getApproval('ap-plain');
      expect(read).toEqual(plain);
      expect(read).not.toHaveProperty('questions');
      expect(read).not.toHaveProperty('selections');
    },
  );
});
