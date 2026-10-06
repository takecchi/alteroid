import { verifyAttachmentStoreContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PgAttachmentStore } from './attachments.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * 添付ファイルの pg 実装（#3111 段1a）。契約（`verifyAttachmentStoreContract`）を実 PostgreSQL（PGlite）で通し、
 * 加えて pg 固有の性質を見る: 控えだけの問い合わせ（`getMeta` / `prune`）が `bytes` 列を読まない・
 * 起動を2回通しても壊れない。
 */
let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});
afterEach(async () => {
  await client.close();
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

describe('PgAttachmentStore', () => {
  it('契約を通る', async () => {
    const db = client.withLogger({ logQuery: () => undefined });
    const extra: TestDbHandle[] = [];
    try {
      await verifyAttachmentStoreContract(new PgAttachmentStore(db), {
        // 空のストアが要るので、呼ぶたびに別の DB を作る。
        createStore: async (options) => {
          const { client: fresh } = await createMigratedTestDb();
          extra.push(fresh);
          return new PgAttachmentStore(fresh.withLogger({ logQuery: () => undefined }), options);
        },
      });
    } finally {
      for (const fresh of extra) await fresh.close();
    }
  });

  it('getMeta と prune は bytes 列を読まない（SQL に bytes が現れない）', async () => {
    const queries: string[] = [];
    const db = client.withLogger({ logQuery: (query: string) => queries.push(query) });
    const store = new PgAttachmentStore(db);
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });

    queries.length = 0;
    await store.getMeta(meta.id);
    await store.prune(new Date(Date.now() + 2 * 3_600_000));
    expect(queries).toHaveLength(2);
    for (const query of queries) expect(query).not.toMatch(/"bytes"/);

    // 対照: get は bytes を読む
    const other = await store.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    queries.length = 0;
    await store.get(other.id);
    expect(queries[0]).toMatch(/"bytes"/);
  });

  it('bytes は欠けなく往復する（全バイト値）', async () => {
    const db = client.withLogger({ logQuery: () => undefined });
    const store = new PgAttachmentStore(db);
    const all = new Uint8Array(256).map((_, i) => i);
    const meta = await store.put({
      name: 'all.bin',
      mediaType: 'application/octet-stream',
      bytes: all,
    });
    const got = await store.get(meta.id);
    expect(Array.from(got!.bytes)).toEqual(Array.from(all));
    expect(got!.meta.size).toBe(256);
  });

  it('migrate を2回通しても落ちない（表と索引が在る）', async () => {
    const db = client.withLogger({ logQuery: () => undefined });
    await migrate(db);
    await migrate(db);
    const rows = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'attachments' order by indexname`,
    );
    expect(rows.rows.map((row) => row.indexname)).toEqual([
      'attachments_created_at_idx',
      'attachments_expires_at_idx',
      'attachments_pkey',
    ]);
  });
});
