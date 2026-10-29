import { describe, expect, it } from 'vitest';

import {
  migrateCommitmentsToTasks,
  migrationTaskTitle,
  planCommitmentMigration,
} from './commitment-task-migration.js';
import { verifyCommitmentTaskMigrationContract } from './commitment-task-migration-contract.js';
import type { Commitment } from './schema.js';
import { createMemoryStores } from './testing.js';

const row = (
  id: string,
  at: string,
  origin: Commitment['origin'],
  extra: Partial<Commitment> = {},
): Commitment => ({ id, at, origin, body: `本文-${id}`, ...extra });

describe('planCommitmentMigration（純関数）', () => {
  it('開いている human は task、それ以外は retire、閉じた行は skip-closed。at の古い順に並べる', () => {
    const plan = planCommitmentMigration(
      [
        row('h2', '2026-10-02T00:00:00.000Z', 'human'),
        row('m1', '2026-09-30T00:00:00.000Z', 'manager'),
        row('h1', '2026-10-01T00:00:00.000Z', 'human'),
        row('c1', '2026-09-01T00:00:00.000Z', 'human', { closedAt: '2026-09-02T00:00:00.000Z' }),
        row('x1', '2026-10-03T00:00:00.000Z', 'external'),
        row('s1', '2026-10-04T00:00:00.000Z', 'self'),
      ],
      new Set(),
    );
    expect(plan.rows.map((item) => `${item.action}:${item.commitment.id}`)).toEqual([
      'skip-closed:c1',
      'retire:m1',
      'task:h1',
      'task:h2',
      'retire:x1',
      'retire:s1',
    ]);
    expect(plan.summary).toMatchObject({
      total: 6,
      toTask: 2,
      closeOnly: 0,
      retire: 3,
      skipClosed: 1,
      oldestAt: '2026-10-01T00:00:00.000Z',
      newestAt: '2026-10-02T00:00:00.000Z',
    });
    expect(plan.summary.byOrigin.human).toEqual({
      toTask: 2,
      closeOnly: 0,
      retire: 0,
      skipClosed: 1,
    });
    expect(plan.summary.byOrigin.manager.retire).toBe(1);
  });

  it('Task が既に在る id は close-only（Task が done でも id で判る）', () => {
    const plan = planCommitmentMigration(
      [
        row('h1', '2026-10-01T00:00:00.000Z', 'human'),
        row('h2', '2026-10-02T00:00:00.000Z', 'human'),
      ],
      new Set(['h1']),
    );
    expect(plan.rows.map((item) => item.action)).toEqual(['close-only', 'task']);
    expect(plan.summary).toMatchObject({ toTask: 1, closeOnly: 1 });
  });

  it('同じ at は id で順序を決める（実行のたびに並びが変わらない）', () => {
    const at = '2026-10-01T00:00:00.000Z';
    const plan = planCommitmentMigration([row('b', at, 'human'), row('a', at, 'human')], new Set());
    expect(plan.rows.map((item) => item.commitment.id)).toEqual(['a', 'b']);
  });

  it('Task にする行が無ければ最古/最新は null', () => {
    const plan = planCommitmentMigration([], new Set());
    expect(plan.summary.oldestAt).toBeNull();
    expect(plan.summary.newestAt).toBeNull();
  });
});

describe('migrationTaskTitle', () => {
  it('先頭の空でない行を60字までに切る。空なら（本文なし）', () => {
    expect(migrationTaskTitle('\n  最初の行  \n二行目')).toBe('最初の行');
    expect([...migrationTaskTitle('あ'.repeat(100))]).toHaveLength(60);
    expect(migrationTaskTitle('あ'.repeat(100)).endsWith('…')).toBe(true);
    expect(migrationTaskTitle('あ'.repeat(60))).toBe('あ'.repeat(60));
    expect(migrationTaskTitle('  \n ')).toBe('（本文なし）');
  });
});

describe('台帳→Task の移行（メモリ）', () => {
  it('3実装共通の契約を満たす', async () => {
    await verifyCommitmentTaskMigrationContract(async () => ({ stores: createMemoryStores() }));
  });

  it('日誌の decision には元の id・origin・本文が逐語で残る', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open(
      row('h1', '2026-10-01T00:00:00.000Z', 'human', { body: '逐語\n本文' }),
    );
    await stores.commitments.open(row('m1', '2026-10-01T01:00:00.000Z', 'manager'));
    await migrateCommitmentsToTasks(stores, { dryRun: false, now: '2026-10-29T00:00:00.000Z' });
    const decisions = (await stores.journal.list()).flatMap((entry) =>
      entry.type === 'decision' ? [entry] : [],
    );
    const human = decisions.find((entry) => entry.decision.includes('h1'));
    expect(human?.decision).toContain('human');
    expect(human?.decision).toContain('逐語\n本文');
    const retired = decisions.find((entry) => entry.decision.includes('m1'));
    expect(retired?.decision).toContain('manager');
    expect(retired?.decision).toContain('本文-m1');
  });

  it('多数行でも例外で止まらない', async () => {
    const stores = createMemoryStores();
    for (let index = 0; index < 200; index += 1) {
      const at = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
      await stores.commitments.open(row(`h${String(index).padStart(3, '0')}`, at, 'human'));
    }
    const report = await migrateCommitmentsToTasks(stores, {
      dryRun: false,
      now: '2026-10-29T00:00:00.000Z',
    });
    expect(report.execution?.migrated).toBe(200);
    const ids = (await stores.tasks.list()).entries.map((task) => task.id);
    expect(ids).toEqual([...ids].sort());
  });
});
