import { captureStderr } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 墓標が名指しした行（`hiddenEntryIds`）を外す条件を、jsonb の `?` から id の集合（`NOT IN`）へ書き換えた（#5089）。
// 書き換える前の条件と同じ行を外すことを、名指しの形（配列・オブジェクト・文字列・数など）ごとに突き合わせる

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

// 書き換える前の条件（そのまま写した）
const BEFORE = sql.raw(
  `NOT ("journal"."type" = 'exchange' AND EXISTS (SELECT 1 FROM journal t WHERE t.type = 'conversation_deleted' AND t.entry->>'deletedConversationId' = "journal"."entry"->>'conversationId')) AND NOT EXISTS (SELECT 1 FROM journal h WHERE h.type = 'conversation_deleted' AND h.entry->'hiddenEntryIds' ? "journal"."id")`,
);

let seq = 0;
async function insert(id: string, type: string, entry: Record<string, unknown>): Promise<void> {
  seq += 1;
  await db.insert(journal).values({
    id,
    at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + seq * 1000),
    type,
    entry,
  });
}

function exchange(conversationId: string): Record<string, unknown> {
  return { with: 'human', role: 'inbound', text: 'こんにちは', conversationId };
}

function decision(): Record<string, unknown> {
  return { decision: '決めた', grounds: '理由' };
}

function tombstone(
  hiddenEntryIds: unknown,
  deletedConversationId = 'conv-gone',
): Record<string, unknown> {
  return { deletedConversationId, deletedBy: 'human', hiddenCount: 1, hiddenEntryIds };
}

describe('墓標が名指しした行を外す（#5089）', () => {
  it('⭐ 名指しの形ごとに、書き換える前の条件と同じ行を外す', async () => {
    // 外される側の候補
    for (const id of [
      'by-array',
      'by-object-key',
      'by-string',
      'num-123',
      'by-nested',
      'by-null-text',
      'kept-1',
      'kept-2',
      '123',
      'null',
      'true',
    ]) {
      await insert(id, 'decision', decision());
    }
    await insert('ex-alive', 'exchange', exchange('conv-alive'));
    await insert('ex-gone', 'exchange', exchange('conv-gone'));
    await insert('ex-array', 'exchange', exchange('conv-alive'));

    // 名指しの形
    await insert(
      't-array',
      'conversation_deleted',
      tombstone(['by-array', 'ex-array', 7, null, true, ['by-nested']]),
    );
    await insert(
      't-object',
      'conversation_deleted',
      tombstone({ 'by-object-key': 1, x: 'kept-1' }, 'conv-x'),
    );
    await insert('t-string', 'conversation_deleted', tombstone('by-string', 'conv-y'));
    await insert('t-number', 'conversation_deleted', tombstone(123, 'conv-z'));
    await insert('t-null', 'conversation_deleted', tombstone(null, 'conv-w'));
    await insert('t-missing', 'conversation_deleted', { deletedConversationId: 'conv-v' });

    const before: string[] = (
      await db.select({ id: journal.id }).from(journal).where(BEFORE).orderBy(journal.seq)
    ).map((row) => row.id);

    let listed: string[] = [];
    await captureStderr(async () => {
      listed = (await stores.journal.list({ order: 'asc' })).map((entry) => entry.id);
    });

    // 形の崩れた墓標そのものは型に合わず読み出しで落ちる（書き換えの前後で同じ）ので、比べる側からも外す
    const unreadableTombstones = [
      't-array',
      't-object',
      't-string',
      't-number',
      't-null',
      't-missing',
    ];
    expect(listed).toEqual(before.filter((id) => !unreadableTombstones.includes(id)));
    // 中身の確かめ: 名指しされた行と、消した会話の exchange は外れ、そうでない行は残る
    for (const hidden of ['by-array', 'ex-array', 'by-object-key', 'by-string', 'ex-gone']) {
      expect(listed).not.toContain(hidden);
    }
    for (const kept of [
      'kept-1',
      'kept-2',
      'num-123',
      'by-nested',
      'by-null-text',
      '123',
      'null',
      'true',
      'ex-alive',
    ]) {
      expect(listed).toContain(kept);
    }
  });

  it('⭐ 名指しの集合は外側の行ごとに作り直さず、ハッシュにして1回だけ作る（計画の見積もりに左右されない）', async () => {
    await insert('t', 'conversation_deleted', tombstone(['x']));
    // 日誌の読み出しが実際に打つ SQL を捕まえて、そのまま EXPLAIN する
    const queries: { sql: string; params: unknown[] }[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({
        logQuery: (text, params) => {
          queries.push({ sql: text, params });
        },
      }),
    );
    await captureStderr(async () => {
      await logged.journal.list({ types: ['exchange'], with: ['human'], limit: 10 });
    });
    const query = queries.find((entry) => entry.sql.includes('NOT IN'));
    if (query === undefined) throw new Error('日誌の読み出しの SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain('hashed SubPlan');
    expect(plan).not.toMatch(/Nested Loop Anti Join/);
  });

  it('get と oldestAt も同じく外す', async () => {
    await insert('first-hidden', 'decision', decision());
    await insert('second', 'decision', decision());
    await insert('t', 'conversation_deleted', tombstone(['first-hidden']));
    await captureStderr(async () => {
      expect(await stores.journal.get('first-hidden')).toBeNull();
      expect(await stores.journal.get('second')).not.toBeNull();
      expect(await stores.journal.oldestAt()).toBe(
        new Date(Date.parse('2026-10-01T00:00:00.000Z') + (seq - 1) * 1000).toISOString(),
      );
    });
  });
});
