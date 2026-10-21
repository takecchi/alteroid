import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 大文字・小文字の別を持たない語は LIKE で引く（#5126）

let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

async function searchSqlOf(q: string): Promise<string> {
  const queries: string[] = [];
  const logged = createPgStoresFromDb(
    client.withLogger({ logQuery: (text) => void queries.push(text) }),
  );
  await logged.journal.listPage({ limit: 50, q });
  const found = queries.findLast((text) => text.includes(`escape '\\'`));
  if (found === undefined) throw new Error('検索の SQL を捕まえられなかった');
  return found;
}

describe('日誌の検索の照合の形（#5126）', () => {
  it('⭐ 大文字・小文字の別を持たない語（日本語・数字・記号だけ）は like で引き、ilike を使わない', async () => {
    for (const q of ['ふくろう', '50%', '進捗は50%']) {
      const text = await searchSqlOf(q);
      expect(text).toContain(' like ');
      expect(text).not.toContain(' ilike ');
    }
  });

  it('大文字・小文字の別を持つ文字が1つでも在る語は ilike で引く', async () => {
    for (const q of ['verbatim', 'をverbatimで', 'ß']) {
      const text = await searchSqlOf(q);
      expect(text).toContain(' ilike ');
    }
  });

  it('like で引いても、本文に英字の大文字が混ざる行に、日本語の語で当たる', async () => {
    const stores = createPgStoresFromDb(client.withLogger({ logQuery: () => undefined }));
    const row = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'ふくろうのABCを見た',
    });

    const page = await stores.journal.listPage({ limit: 50, q: 'ふくろうの' });

    expect(page.entries.map((entry) => entry.id)).toEqual([row.id]);
  });
});
