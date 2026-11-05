import type { PendingApproval } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// `migrate` が、決着の列が空で本体にだけ時刻がある行（`withdrawn_at` を足す前の行）を、本体の時刻で埋め戻す。
// 埋め戻した後は、未決着の一覧も列だけで決まり、ファイルの記憶（本体の欄で決める）とそろう。

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

function approval(id: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: '2026-09-01T00:00:00.000Z', question: `質問 ${id}`, ...over };
}

async function clearColumns(id: string): Promise<void> {
  await client.exec(
    `update approvals set answered_at = null, withdrawn_at = null where id = '${id}'`,
  );
}

async function columnsOf(
  id: string,
): Promise<{ answered_at: string | null; withdrawn_at: string | null }> {
  const result = await client.query<{ answered_at: string | null; withdrawn_at: string | null }>(
    `select answered_at::text as answered_at, withdrawn_at::text as withdrawn_at from approvals where id = '${id}'`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`行が無い: ${id}`);
  return row;
}

describe('approvals の決着の列の埋め戻し（migrate）', () => {
  it('古い取り下げ済みの行は、移行の後は未決着の一覧に出ない（ファイルの記憶とそろう）', async () => {
    await stores.jobs.putApproval(
      approval('ap-legacy-withdrawn', {
        withdrawnAt: '2026-09-10T04:05:06.789Z',
        withdrawnReason: '要らない',
      }),
    );
    await stores.jobs.putApproval(
      approval('ap-legacy-answered', { answeredAt: '2026-09-03T01:02:03+09:00', answer: '回答' }),
    );
    await stores.jobs.putApproval(approval('ap-open'));
    await clearColumns('ap-legacy-withdrawn');
    await clearColumns('ap-legacy-answered');

    await migrate(db);

    const pending = await stores.jobs.listApprovals({ pendingOnly: true });
    expect(pending.entries.map((entry) => entry.id)).toEqual(['ap-open']);
    expect(
      new Date((await columnsOf('ap-legacy-withdrawn')).withdrawn_at ?? '').toISOString(),
    ).toBe('2026-09-10T04:05:06.789Z');
    expect(new Date((await columnsOf('ap-legacy-answered')).answered_at ?? '').toISOString()).toBe(
      '2026-09-02T16:02:03.000Z',
    );
    expect(await stores.jobs.listApprovalSettledAts()).toEqual(
      expect.arrayContaining(['2026-09-10T04:05:06.789Z', '2026-09-02T16:02:03.000Z']),
    );
  }, 30_000);

  it('本体の時刻が日時の形でない行があっても、移行は落ちず、その行の列は空のまま', async () => {
    await stores.jobs.putApproval(approval('ap-broken'));
    await client.exec(
      `update approvals set approval = approval || '{"withdrawnAt": "いつか", "answeredAt": 12}'::jsonb where id = 'ap-broken'`,
    );

    await migrate(db);
    await migrate(db);

    expect(await columnsOf('ap-broken')).toEqual({ answered_at: null, withdrawn_at: null });
  }, 30_000);
});
