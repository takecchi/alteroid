import { captureStderr } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { PgJournalStore } from './journal.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 読み出しから外す行の集合（消した会話の id・墓標が名指しした id）を、器の側で覚えて配列で渡す（#5089）。
// 覚えは墓標の件数と最後の `seq` の印が変わったときだけ引き直す。別のプロセスが墓標を積んでも取りこぼさないことと、意味が元の SQL と変わらないことを測る

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

async function ids(store: PgJournalStore): Promise<string[]> {
  // 墓標そのものは外れない（読める行）ので、比べる側から除く
  return (await store.list({ order: 'asc' }))
    .filter((entry) => entry.type !== 'conversation_deleted')
    .map((entry) => entry.id);
}

async function exchange(store: PgJournalStore, conversationId: string | undefined) {
  return store.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: 'こんにちは',
    ...(conversationId === undefined ? {} : { conversationId }),
  });
}

async function tombstone(
  store: PgJournalStore,
  deletedConversationId: string,
  hiddenEntryIds?: string[],
) {
  return store.append({
    type: 'conversation_deleted',
    deletedConversationId,
    deletedBy: 'operator',
    hiddenCount: hiddenEntryIds?.length ?? 0,
    ...(hiddenEntryIds === undefined ? {} : { hiddenEntryIds }),
  });
}

describe('外す行の集合の覚え（#5089）', () => {
  it('⭐ 墓標を足すと、次の読みからその会話の往復と名指しの行が外れる（覚えが印で読み直される）', async () => {
    const store = new PgJournalStore(db);
    const gone = await exchange(store, 'conv-gone');
    const alive = await exchange(store, 'conv-alive');
    const named = await store.append({ type: 'decision', decision: '決めた', grounds: '理由' });
    // 覚えを作る（墓標が無い集合）
    expect(await ids(store)).toEqual([gone.id, alive.id, named.id]);
    expect(await store.get(gone.id)).not.toBeNull();

    await captureStderr(async () => {
      await tombstone(store, 'conv-gone', [named.id]);
      expect(await ids(store)).toEqual([alive.id]);
      expect(await store.get(gone.id)).toBeNull();
      expect(await store.get(named.id)).toBeNull();
    });
  });

  it('⭐ 別の PgJournalStore（別のプロセスに見立てる）が墓標を積んでも、次の読みで外れる', async () => {
    const reader = new PgJournalStore(db);
    const writer = new PgJournalStore(db);
    const gone = await exchange(writer, 'conv-gone');
    const named = await writer.append({ type: 'decision', decision: '決めた', grounds: '理由' });
    expect(await ids(reader)).toEqual([gone.id, named.id]);

    const stone = await tombstone(writer, 'conv-gone', [named.id]);

    expect(await ids(reader)).toEqual([]);
    expect(await reader.get(gone.id)).toBeNull();
    // 外れた行より後ろの墓標そのものが、いちばん古い読める行になる
    expect(await reader.oldestAt()).toBe(stone.at);
    expect(await reader.humanReplies()).toEqual([]);
    expect(
      await reader.countToolUsesByActor?.({
        since: '1970-01-01T00:00:00.000Z',
        until: '2100-01-01T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('`conversationId` の無い exchange は、墓標があっても外れない', async () => {
    const store = new PgJournalStore(db);
    const without = await exchange(store, undefined);
    const gone = await exchange(store, 'conv-gone');
    await tombstone(store, 'conv-gone');

    await captureStderr(async () => {
      expect(await ids(store)).toEqual([without.id]);
      expect(await store.get(without.id)).not.toBeNull();
      expect(await store.get(gone.id)).toBeNull();
    });
  });

  it('`deletedConversationId` が NULL・欠落の墓標があっても、全行が外れない（配列に NULL を入れない）', async () => {
    const store = new PgJournalStore(db);
    const alive = await exchange(store, 'conv-alive');
    const decision = await store.append({ type: 'decision', decision: '決めた', grounds: '理由' });
    await db.insert(journal).values([
      { id: 't-missing', at: new Date(), type: 'conversation_deleted', entry: {} },
      {
        id: 't-null',
        at: new Date(),
        type: 'conversation_deleted',
        entry: { deletedConversationId: null, hiddenEntryIds: [] },
      },
    ]);

    await captureStderr(async () => {
      expect(await ids(store)).toEqual([alive.id, decision.id]);
      expect(await store.get(decision.id)).not.toBeNull();
    });
  });

  it('墓標が無いときは何も外さない（空の配列）', async () => {
    const store = new PgJournalStore(db);
    const first = await exchange(store, 'conv-a');
    const second = await exchange(store, undefined);
    expect(await ids(store)).toEqual([first.id, second.id]);
  });

  it('⭐ 印が変わらなければ集合を引き直さず、読み出しの SQL に墓標を読む部分問い合わせも無い', async () => {
    const queries: string[] = [];
    const logged = new PgJournalStore(
      client.withLogger({ logQuery: (text) => void queries.push(text) }),
    );
    await tombstone(logged, 'conv-gone', ['x']);

    await logged.list({});
    const afterFirst = queries.length;
    await logged.list({});
    await logged.list({});

    const sinceFirst = queries.slice(afterFirst);
    // 2回目以降は、印を1本引いてから本体を打つ（1回に2本）。印だけが墓標の行を読む（件数と最後の seq）
    expect(sinceFirst).toHaveLength(4);
    expect(sinceFirst.filter((text) => text.includes('count(*)::text'))).toHaveLength(2);
    for (const text of sinceFirst.filter((text) => text.includes('<> ALL'))) {
      expect(text).not.toContain('conversation_deleted');
      expect(text).not.toContain('hiddenEntryIds');
    }
  });
});
