import type { Commitment } from '@alteroid/core';
import { captureStderr } from '@alteroid/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { PgCommitmentStore } from './commitments.js';
import { commitments } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 片付いた行の本文を毎回読み直さない覚え（#5089）。覚えた後の一覧が、毎回作り直した器で読んだ一覧と同じことを測る

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

function row(id: string, minute: number): Commitment {
  return {
    id,
    at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + minute * 60_000).toISOString(),
    origin: 'human',
    body: `${id} の本文`,
  };
}

async function closeRow(store: PgCommitmentStore, id: string, minute: number): Promise<void> {
  await store.close(
    id,
    new Date(Date.parse('2026-09-02T00:00:00.000Z') + minute * 60_000).toISOString(),
    `${id} を片付けた`,
    'human',
  );
}

/** 覚えを持たない新しい器で読んだ一覧（比べる基準） */
async function freshList() {
  return new PgCommitmentStore(db).list({ includeClosed: true });
}

describe('PgCommitmentStore の片付いた行の覚え（#5089）', () => {
  it('⭐ 書き換え・新しく片付いた行・消えた行・読めない行が、覚えた後の一覧にもそのまま出る', async () => {
    const store = new PgCommitmentStore(db);
    for (let i = 0; i < 6; i += 1) await store.open(row(`c-${String(i)}`, i));
    for (let i = 0; i < 4; i += 1) await closeRow(store, `c-${String(i)}`, i);

    expect(await store.list({ includeClosed: true })).toEqual(await freshList());

    // 新しく片付いた行
    await closeRow(store, 'c-4', 10);
    // 片付いた行の本体を直に書き換える（版が変わる）
    await db
      .update(commitments)
      .set({
        commitment: {
          ...row('c-0', 0),
          closedAt: '2026-09-02T00:00:00.000Z',
          closedReason: '書き換えた理由',
          closedBy: 'human',
        },
      })
      .where(eq(commitments.id, 'c-0'));
    // 片付いた行が消える（保持上限の刈り込みなど）
    await db.delete(commitments).where(eq(commitments.id, 'c-1'));
    // 片付いた行が読めない形になる
    await db
      .update(commitments)
      .set({ commitment: { id: 'c-2', body: 42 } })
      .where(eq(commitments.id, 'c-2'));

    let cached: Awaited<ReturnType<PgCommitmentStore['list']>> | undefined;
    let fresh: Awaited<ReturnType<PgCommitmentStore['list']>> | undefined;
    await captureStderr(async () => {
      cached = await store.list({ includeClosed: true });
      fresh = await freshList();
    });
    expect(cached).toEqual(fresh);
    expect(cached?.entries.find((entry) => entry.id === 'c-0')?.closedReason).toBe(
      '書き換えた理由',
    );
    expect(cached?.entries.some((entry) => entry.id === 'c-1')).toBe(false);
    expect(cached?.unreadable.map((entry) => entry.id)).toEqual(['c-2']);
    expect(cached?.entries.some((entry) => entry.id === 'c-4')).toBe(true);
  });

  it('⭐ 2回目からは、版の変わった片付いた行だけ本文を読み直す', async () => {
    const store = new PgCommitmentStore(db);
    for (let i = 0; i < 5; i += 1) await store.open(row(`c-${String(i)}`, i));
    for (let i = 0; i < 5; i += 1) await closeRow(store, `c-${String(i)}`, i);

    // 打った SQL を数える器（1回目は全部読み、2回目からは読み直さない）
    const queries: { sql: string; params: unknown[] }[] = [];
    const watched = new PgCommitmentStore(
      client.withLogger({
        logQuery: (text, params) => {
          queries.push({ sql: text, params });
        },
      }),
    );
    await watched.list({ includeClosed: true });
    const firstBodies = queries.filter((query) => query.sql.includes('"commitment"')).length;
    queries.length = 0;
    await watched.list({ includeClosed: true });
    // 未了の行は毎回本文ごと読む（1本）。片付いた行の本文は読まない
    const secondBodySelects = queries.filter(
      (query) => query.sql.includes('"commitment"') && query.sql.includes('is not null'),
    );
    expect(firstBodies).toBeGreaterThan(0);
    expect(secondBodySelects).toHaveLength(0);

    // 1行だけ書き換えると、その1行だけ読み直す
    await db
      .update(commitments)
      .set({
        commitment: {
          ...row('c-3', 3),
          body: '直した本文',
          closedAt: '2026-09-02T00:03:00.000Z',
          closedReason: 'c-3 を片付けた',
          closedBy: 'human',
        },
      })
      .where(eq(commitments.id, 'c-3'));
    queries.length = 0;
    const after = await watched.list({ includeClosed: true });
    const reread = queries.filter(
      (query) => query.sql.includes('"commitment"') && query.sql.includes(' in '),
    );
    expect(reread).toHaveLength(1);
    expect(reread[0]?.params).toContain('c-3');
    expect(after.entries.find((entry) => entry.id === 'c-3')?.body).toBe('直した本文');
  });

  it('返した行を書き換えても、次の一覧は変わらない', async () => {
    const store = new PgCommitmentStore(db);
    await store.open(row('c-0', 0));
    await closeRow(store, 'c-0', 0);
    const first = await store.list({ includeClosed: true });
    const target = first.entries.find((entry) => entry.id === 'c-0');
    if (target === undefined) throw new Error('無い');
    target.body = '呼び手が書き換えた';
    const second = await store.list({ includeClosed: true });
    expect(second.entries.find((entry) => entry.id === 'c-0')?.body).toBe('c-0 の本文');
  });
});
