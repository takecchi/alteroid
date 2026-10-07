import { captureStderr, verifyAttachmentStoreContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PgAttachmentStore } from './attachments.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});
afterEach(async () => {
  await client.close();
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

describe('PgAttachmentStore', () => {
  // 既定の 5000ms にしない: `createStore` が DB を4つ作り、混んだ runner で時間切れになるため。
  it('契約を通る', async () => {
    const db = client.withLogger({ logQuery: () => undefined });
    const extra: TestDbHandle[] = [];
    try {
      await verifyAttachmentStoreContract(new PgAttachmentStore(db), {
        createStore: async (options) => {
          const { client: fresh } = await createMigratedTestDb();
          extra.push(fresh);
          return new PgAttachmentStore(fresh.withLogger({ logQuery: () => undefined }), options);
        },
      });
    } finally {
      for (const fresh of extra) await fresh.close();
    }
  }, 60_000);

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

describe('PgAttachmentStore: bind が途中で例外を投げた回（#3592）', () => {
  it('UPDATE のあとの SELECT が落ちたら、この呼びで結んだ分を戻して元の例外を投げる', async () => {
    const real = new PgAttachmentStore(client.withLogger({ logQuery: () => undefined }));
    const a = await real.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await real.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    await real.bind([b.id], 'conv-other');
    const db = client.withLogger({ logQuery: () => undefined });
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'select') {
          return () => ({
            from: () => ({ where: () => Promise.reject(new Error('EIO')) }),
          });
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      new PgAttachmentStore(failing).bindToExternalEvent([a.id, b.id], 'ev-1'),
    ).rejects.toThrow('EIO');
    expect((await real.getMeta(a.id))?.externalEventId).toBeUndefined();
    expect((await real.getMeta(b.id))?.conversationId).toBe('conv-other');
  });

  it('戻しも落ちたら、元の例外を投げ、戻せなかったことを stderr へ1行残す', async () => {
    const real = new PgAttachmentStore(client.withLogger({ logQuery: () => undefined }));
    const a = await real.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await real.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    await real.bind([b.id], 'conv-other');
    const db = client.withLogger({ logQuery: () => undefined });
    let updates = 0;
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'select') {
          return () => ({
            from: () => ({ where: () => Promise.reject(new Error('EIO')) }),
          });
        }
        if (prop === 'update') {
          updates += 1;
          if (updates > 1) {
            return () => ({
              set: () => ({
                where: () => ({ returning: () => Promise.reject(new Error('EIO-rollback')) }),
              }),
            });
          }
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const lines = await captureStderr(async () => {
      await expect(
        new PgAttachmentStore(failing).bindToExternalEvent([a.id, b.id], 'ev-1'),
      ).rejects.toThrow('EIO');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('添付の結び付けを戻せなかった');
    expect(lines[0]).toContain('外部イベントへ結んだ 1 件');
    expect(lines[0]).toContain('EIO-rollback');
    expect(lines[0]).not.toContain('a.png');
  });
});
