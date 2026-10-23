import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countUnreadConversations, type JournalStore } from '@alteroid/core';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 未読のある会話の数（GET /conversations/unread-count）が、人間への返答の口（humanReplies）で数えても、
// 人間との往復を本文ごとチャンクで読む今までの道と同じ答え（数・上限を超えたか・取り込んだ索引）を返すこと

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

type Store = ReturnType<typeof createPgStoresFromDb>;

/** チャンクで読む今までの道: 返答の口を持たない器として見せる */
function chunksOnly(store: Store['journal']): Pick<JournalStore, 'list'> {
  return { list: (query) => store.list(query) };
}

const BASE = Date.parse('2026-10-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

async function seed(): Promise<void> {
  const rows: (typeof journal.$inferInsert)[] = [];
  let n = 0;
  const say = (minutes: number, conversationId: string, role: 'inbound' | 'outbound') => {
    n += 1;
    rows.push({
      id: `row-${String(n)}`,
      at: at(minutes),
      type: 'exchange',
      entry: { with: 'human', role, text: `発言 ${String(n)}`, conversationId },
    });
  };
  // 基準時刻（60 分）より前の返答は数えない
  say(10, 'conv-old', 'outbound');
  // 基準時刻の後: 返答のある会話 3 つ、問いだけの会話 1 つ
  say(70, 'conv-a', 'inbound');
  say(71, 'conv-a', 'outbound');
  say(80, 'conv-b', 'outbound');
  say(90, 'conv-b', 'outbound');
  say(95, 'conv-c', 'outbound');
  say(96, 'conv-q', 'inbound');
  // 消した会話の返答は数えない
  say(97, 'conv-gone', 'outbound');
  rows.push({
    id: 'row-tomb',
    at: at(98),
    type: 'conversation_deleted',
    entry: { deletedConversationId: 'conv-gone', deletedBy: 'operator', hiddenCount: 1 },
  });
  // マネージャーとの往復は数えない
  rows.push({
    id: 'row-manager',
    at: at(99),
    type: 'exchange',
    entry: { with: 'manager', role: 'outbound', text: 'm', conversationId: 'conv-m' },
  });
  // 型の合わない行（text が無い）は数えない
  rows.push({
    id: 'row-bad',
    at: at(100),
    type: 'exchange',
    entry: { with: 'human', role: 'outbound', conversationId: 'conv-bad' },
  });
  await db.insert(journal).values(rows);
}

async function freshStores(): Promise<Store> {
  return createPgStoresFromDb(db);
}

describe('countUnreadConversations を humanReplies で数える', () => {
  it('⭐ 未読の数・上限を超えたか・取り込んだ索引が、チャンクで読む道と同じ', async () => {
    await seed();
    const now = at(200).toISOString();

    // 同じ DB の上で、既読の記録を空から2回測る（道ごとに索引を作り直すため、測るたびに消す）
    const results: unknown[] = [];
    for (const via of ['humanReplies', 'chunks'] as const) {
      await client.exec('delete from conversation_read');
      await client.exec('delete from conversation_outbound_latest');
      await client.exec('delete from conversation_read_baseline');
      const stores = await freshStores();
      await stores.conversationReads.ensureBaseline(at(60).toISOString());
      // conv-b は 85 分まで読んだ（90 分の返答は未読）。conv-c は全部読んだ
      await stores.conversationReads.advance('conv-b', at(85).toISOString());
      await stores.conversationReads.advance('conv-c', at(95).toISOString());
      const result = await countUnreadConversations({
        journal: via === 'humanReplies' ? stores.journal : chunksOnly(stores.journal),
        reads: stores.conversationReads,
        now,
      });
      const index = await stores.conversationReads.readOutboundIndex();
      results.push({
        result,
        lastOutbound: index.state === 'ok' ? index.lastOutbound : index,
      });
    }
    expect(results[0]).toEqual(results[1]);
    // 未読は conv-a と conv-b の 2 つ。基準時刻より前の返答（conv-old）・消した会話・マネージャー・型の合わない行は索引に入らない
    expect(results[0]).toMatchObject({ result: { count: 2, capped: false } });
    expect(Object.keys((results[0] as { lastOutbound: object }).lastOutbound).sort()).toEqual([
      'conv-a',
      'conv-b',
      'conv-c',
    ]);
  });

  it('⭐ 返答の口を持つ器では、日誌を本文ごと読まない（entry を丸ごと選ぶ問い合わせを打たない）', async () => {
    await seed();
    const queries: string[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({ logQuery: (text) => void queries.push(text) }),
    );
    await logged.conversationReads.ensureBaseline(at(60).toISOString());

    await countUnreadConversations({
      journal: logged.journal,
      reads: logged.conversationReads,
      now: at(200).toISOString(),
    });

    expect(
      queries.filter((text) => /select "id", "at", "type", "entry" from "journal"/.test(text)),
    ).toEqual([]);
  });
});
