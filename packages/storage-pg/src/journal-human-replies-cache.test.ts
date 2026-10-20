import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { HUMAN_REPLIES_FULL_REFRESH_MS, PgJournalStore } from './journal.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 人間への返答の覚え（#5089）。読み足した結果が、覚えを持たない器で全部読んだ結果と同じことを測る

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

type Reply = { conversationId: string; at: string };

function sorted(replies: Reply[]): Reply[] {
  return [...replies].sort((a, b) =>
    a.at === b.at ? a.conversationId.localeCompare(b.conversationId) : a.at.localeCompare(b.at),
  );
}

async function fresh(): Promise<Reply[]> {
  return sorted(await new PgJournalStore(db).humanReplies());
}

async function reply(store: PgJournalStore, conversationId: string, text = '返答') {
  return store.append({ type: 'exchange', with: 'human', role: 'outbound', text, conversationId });
}

describe('PgJournalStore.humanReplies の覚え（#5089）', () => {
  it('⭐ 読み足した結果は、全部読んだ結果と同じ（新しい返答・返答以外の行・墓標で外れる行）', async () => {
    const store = new PgJournalStore(db);
    await reply(store, 'conv-a');
    await reply(store, 'conv-b');
    expect(sorted(await store.humanReplies())).toEqual(await fresh());

    // 新しい返答と、返答ではない行
    await reply(store, 'conv-a');
    await store.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '頼む',
      conversationId: 'conv-c',
    });
    await store.append({ type: 'decision', decision: '決めた', grounds: '理由' });
    expect(sorted(await store.humanReplies())).toEqual(await fresh());
    expect(await store.humanReplies()).toHaveLength(3);

    // 墓標: 会話 conv-b を消し、conv-a の1件を名指しで外す
    const named = await reply(store, 'conv-a', '外す返答');
    await store.append({
      type: 'conversation_deleted',
      deletedConversationId: 'conv-b',
      deletedBy: 'human',
      hiddenCount: 1,
      hiddenEntryIds: [named.id],
    });
    const after = sorted(await store.humanReplies());
    expect(after).toEqual(await fresh());
    expect(after.map((entry) => entry.conversationId)).toEqual(['conv-a', 'conv-a']);
  });

  it('⭐ 前回の最後より手前の seq で遅れて確定した返答も拾う', async () => {
    const store = new PgJournalStore(db);
    const insertReply = (seq: number, id: string, conversationId: string) =>
      db.insert(journal).values({
        seq,
        id,
        at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + seq * 1000),
        type: 'exchange',
        entry: { with: 'human', role: 'outbound', text: '返答', conversationId },
      });
    // seq に隙間を空けて入れ、覚えさせる（前回の最後は seq 100）
    await insertReply(10, 'r-10', 'conv-a');
    await insertReply(100, 'r-100', 'conv-a');
    expect(await store.humanReplies()).toHaveLength(2);

    // 先に払い出され、後から確定した行に見立てて、前回の最後より手前の seq で入れる
    await insertReply(50, 'r-50-late', 'conv-late');
    const replies = sorted(await store.humanReplies());
    expect(replies).toEqual(await fresh());
    expect(replies.map((entry) => entry.conversationId)).toContain('conv-late');
  });

  it('clear() の後と、一定時間たった後は全部読み直す', async () => {
    let now = 0;
    const store = new PgJournalStore(db, { now: () => now });
    await reply(store, 'conv-a');
    expect(await store.humanReplies()).toHaveLength(1);

    await store.clear();
    expect(await store.humanReplies()).toEqual([]);

    await reply(store, 'conv-b');
    expect(await store.humanReplies()).toHaveLength(1);
    now += HUMAN_REPLIES_FULL_REFRESH_MS + 1;
    expect(sorted(await store.humanReplies())).toEqual(await fresh());
  });

  it('2回目からは、前回より後ろだけを読み足す（全部は読まない）', async () => {
    const queries: string[] = [];
    const store = new PgJournalStore(
      client.withLogger({
        logQuery: (text) => {
          queries.push(text);
        },
      }),
    );
    await reply(store, 'conv-a');
    await store.humanReplies();
    queries.length = 0;
    await store.humanReplies();
    const reads = queries.filter((text) => text.includes(`"entry"->>'conversationId'`));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/"journal"\."seq" > \$\d+/);
  });
});
