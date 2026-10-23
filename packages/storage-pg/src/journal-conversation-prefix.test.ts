import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lookupConversation, type JournalStore } from '@alteroid/core';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 会話 id の確かめ（lookupConversation）の見つからない経路が、DB で前方一致を集める口（conversationIdsWithPrefix）を使っても、
// 人間との往復を本文ごと頁で読み切る今までの道と同じ答え（候補・その並び・それより多いか）を返すこと

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

type Store = ReturnType<typeof createPgStoresFromDb>;

/** 頁で読み切る今までの道: 前方一致の口を持たない器として見せる */
function pagesOnly(store: Store['journal']): Pick<JournalStore, 'listPage'> {
  return { listPage: (query) => store.listPage(query) };
}

async function seed(stores: Store): Promise<void> {
  const say = (conversationId: string, text = '発言') =>
    stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text,
      conversationId,
    } as never);
  // bf63fd3d で始まる会話を 7 つ（上限 5 を超える）。最新の発言の順を作った順と入れ替える
  for (let i = 0; i < 7; i += 1) await say(`bf63fd3d-000${String(i)}`);
  await say('bf63fd3d-0002', '0002 に新しい発言（並びの先頭へ）');
  await say('bf63fd3d-0005', '0005 に新しい発言（並びの先頭へ）');
  // c60b1940 で始まる会話は 1 つ（長い本文）
  await say('c60b1940-aaaa', `長い本文 ${'あ'.repeat(5000)}`);
  // 1e2d で始まる会話は 2 つ。片方は消す
  await say('1e2d-kept');
  await say('1e2d-gone');
  await stores.journal.append({
    type: 'conversation_deleted',
    deletedConversationId: '1e2d-gone',
    deletedBy: 'operator',
    hiddenCount: 1,
  } as never);
  // マネージャーとの往復は数えない
  await stores.journal.append({
    type: 'exchange',
    with: 'manager',
    role: 'inbound',
    text: 'マネージャー',
    conversationId: '1e2d-manager',
  } as never);
  // 型の合わない行（role が無い）: listPage は読み出しで落とす
  await db.insert(journal).values({
    id: 'row-bad-role',
    at: new Date(),
    type: 'exchange',
    entry: { with: 'human', text: 'role が無い', conversationId: '1e2d-bad' },
  });
}

describe('lookupConversation の前方一致（conversationIdsWithPrefix）', () => {
  it('⭐ 候補・その並び・上限を超えたか・在るかが、頁で読み切る道と同じ', async () => {
    const stores = createPgStoresFromDb(db);
    await seed(stores);

    for (const given of [
      'bf63fd3d',
      'bf63fd3d-0002',
      'c60b1940',
      'c60b1940-aaaa',
      '1e2d',
      'ffff',
      '',
    ]) {
      const viaDb = await lookupConversation(stores.journal, given);
      const viaPages = await lookupConversation(pagesOnly(stores.journal), given);
      expect({ given, ...viaDb }).toEqual({ given, ...viaPages });
    }
  });

  it('上限を超える前方一致は、最新の発言の新しい順の 5 件と「ほか在る」を返す', async () => {
    const stores = createPgStoresFromDb(db);
    await seed(stores);

    expect(await lookupConversation(stores.journal, 'bf63fd3d')).toEqual({
      found: false,
      candidates: [
        'bf63fd3d-0005',
        'bf63fd3d-0002',
        'bf63fd3d-0006',
        'bf63fd3d-0004',
        'bf63fd3d-0003',
      ],
      moreCandidates: true,
    });
  });

  it('⭐ DB の口は本文を運ばない（返すのは会話 id だけで、行は上限 +1 件まで）', async () => {
    const queries: string[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({ logQuery: (text) => void queries.push(text) }),
    );
    await seed(createPgStoresFromDb(db));

    const matched = await logged.journal.conversationIdsWithPrefix?.({
      prefix: 'bf63fd3d',
      limit: 6,
    });

    expect(matched).toHaveLength(6);
    const prefixQuery = queries.find((text) => text.includes('starts_with('));
    if (prefixQuery === undefined) throw new Error('前方一致の SQL を捕まえられなかった');
    expect(prefixQuery).not.toMatch(/select [^]*"entry"(,| from)/);
  });
});
