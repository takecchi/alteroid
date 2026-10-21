import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 数えるだけ・会話 id だけを引く口は、その問い合わせだけ JIT を切る（`withdrawnClientMessageIds` と同じ作法。#5140）

let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

async function currentJit(): Promise<string | undefined> {
  return (await client.query<{ jit: string }>(`select current_setting('jit') as jit`)).rows[0]?.jit;
}

describe('数えるだけ・会話 id だけを引く口の JIT（#5140）', () => {
  it('⭐ countToolUsesByActor はトランザクションの中で JIT を切ってから数え、接続の jit の設定は元のまま残す', async () => {
    const queries: string[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({ logQuery: (text) => void queries.push(text) }),
    );
    const before = await currentJit();

    await logged.journal.countToolUsesByActor?.({
      since: '1970-01-01T00:00:00.000Z',
      until: '2100-01-01T00:00:00.000Z',
    });

    const setAt = queries.findIndex((text) => text.includes(`set_config('jit', 'off',`));
    const countAt = queries.findIndex((text) => text.includes('count(*)::int'));
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeGreaterThan(setAt);
    expect(await currentJit()).toBe(before);
  });

  it('⭐ conversationIdsAfter はトランザクションの中で JIT を切ってから引き、接続の jit の設定は元のまま残す', async () => {
    const stores = createPgStoresFromDb(client.withLogger({ logQuery: () => undefined }));
    const anchor = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '錨',
      conversationId: 'conv-a',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '後ろ',
      conversationId: 'conv-b',
    });
    const queries: string[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({ logQuery: (text) => void queries.push(text) }),
    );
    const before = await currentJit();

    const ids = await logged.journal.conversationIdsAfter?.({
      after: { id: anchor.id, at: anchor.at },
    });

    expect(ids).toEqual(['conv-b']);
    const setAt = queries.findIndex((text) => text.includes(`set_config('jit', 'off',`));
    // 最後の1本を取る: 外す行の集合の引き直し（これも `select distinct`）は JIT を切った後に打つが、測りたいのは本体の問い合わせのため
    const selectAt = queries.findLastIndex((text) => text.includes('select distinct'));
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(selectAt).toBeGreaterThan(setAt);
    // 集合の引き直しも JIT を切った後（トランザクションの中）に打つ
    expect(queries.findIndex((text) => text.includes('select distinct'))).toBeGreaterThan(setAt);
    expect(await currentJit()).toBe(before);
  });
});
