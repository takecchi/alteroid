import {
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  MemoryAttachmentBlobStore,
  captureStderr,
  verifyAttachmentStoreContract,
  type AttachmentBlobStore,
  type AttachmentLimits,
} from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PgAttachmentStore } from './attachments.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
});

const quiet = () => client.withLogger({ logQuery: () => undefined });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

async function* chunks(...parts: number[][]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Uint8Array.from(part);
}

async function drain(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(out);
}

class HookedBlobs extends MemoryAttachmentBlobStore implements AttachmentBlobStore {
  failPutAfterChunks: number | undefined;
  failRemove = false;
  removeCalls: string[][] = [];

  override async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.failPutAfterChunks === undefined) return super.put(key, body);
    const limit = this.failPutAfterChunks;
    return super.put(
      key,
      (async function* () {
        let count = 0;
        for await (const chunk of body) {
          if (count++ >= limit) throw new Error('blob の置き場が途中で落ちた');
          yield chunk;
        }
        if (count >= limit) throw new Error('blob の置き場が途中で落ちた');
      })(),
    );
  }

  override async remove(keys: readonly string[]): Promise<void> {
    this.removeCalls.push([...keys]);
    if (this.failRemove) throw new Error('blob の削除が落ちた（secret-key-name）');
    return super.remove(keys);
  }
}

async function rowOf(id: string) {
  const rows = await client.query<{ bytes: Buffer | null; blob_key: string | null }>(
    `select bytes, blob_key from attachments where id = '${id}'`,
  );
  return rows.rows[0];
}

describe('PgAttachmentStore + blobs（外部ストレージ。#4128 段2）', () => {
  it('契約を通る（pg + MemoryAttachmentBlobStore）', async () => {
    const extra: TestDbHandle[] = [];
    try {
      await verifyAttachmentStoreContract(
        new PgAttachmentStore(quiet(), { blobs: new MemoryAttachmentBlobStore() }),
        {
          createStore: async (options) => {
            const { client: fresh } = await createMigratedTestDb();
            extra.push(fresh);
            return new PgAttachmentStore(fresh.withLogger({ logQuery: () => undefined }), {
              ...options,
              blobs: new MemoryAttachmentBlobStore(),
            });
          },
        },
      );
    } finally {
      for (const fresh of extra) await fresh.close();
    }
  }, 60_000);

  it('(a) 入れたものは全部（画像も・put も putStream も）bytes が null で、blob に中身がある', async () => {
    const blobs = new MemoryAttachmentBlobStore();
    const store = new PgAttachmentStore(quiet(), { blobs, blobKeyPrefix: 'p/' });
    const viaPut = await store.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('hi'),
    });
    const viaStream = await store.putStream({
      name: 'b.bin',
      mediaType: 'application/octet-stream',
      body: chunks([1, 2], [3]),
    });
    const image = await store.putStream({
      name: 'c.png',
      mediaType: 'image/png',
      body: chunks([...PNG]),
    });
    for (const meta of [viaPut, viaStream, image]) {
      const row = await rowOf(meta.id);
      expect(row?.bytes).toBeNull();
      expect(row?.blob_key).toBe(`p/attachments/${meta.id}`);
      expect(blobs.keys()).toContain(`p/attachments/${meta.id}`);
    }
    expect([...blobs.peek(`p/attachments/${viaStream.id}`)!]).toEqual([1, 2, 3]);
    expect(viaStream.size).toBe(3);
    expect([...(await store.get(viaStream.id))!.bytes]).toEqual([1, 2, 3]);
    expect([...(await drain((await store.open(viaStream.id))!.stream))]).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode((await store.get(viaPut.id))!.bytes)).toBe('hi');
  });

  it('blob が消えていれば get / open は undefined', async () => {
    const blobs = new MemoryAttachmentBlobStore();
    const store = new PgAttachmentStore(quiet(), { blobs });
    const meta = await store.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('hi'),
    });
    await blobs.remove([`attachments/${meta.id}`]);
    expect(await store.get(meta.id)).toBeUndefined();
    expect(await store.open(meta.id)).toBeUndefined();
    expect(await store.getMeta(meta.id)).toBeDefined();
  });

  it('(b) remove / prune / clear で blob も消える', async () => {
    const blobs = new MemoryAttachmentBlobStore();
    const store = new PgAttachmentStore(quiet(), { blobs });
    const put = (name: string) =>
      store.put({ name, mediaType: 'text/plain', bytes: Buffer.from(name) });
    const removed = await put('removed.txt');
    const pruned = await put('pruned.txt');
    const cleared = await put('cleared.txt');

    expect(await store.remove(removed.id)).toBe(true);
    expect(blobs.keys()).not.toContain(`attachments/${removed.id}`);
    expect(blobs.keys()).toHaveLength(2);

    // 結び付けのない残骸は 1 時間たてば prune が消す
    expect(await store.prune(new Date(Date.now() + 2 * 3_600_000))).toBe(2);
    expect(blobs.keys()).toEqual([]);
    expect(await store.getMeta(pruned.id)).toBeUndefined();

    const another = await put('another.txt');
    expect(blobs.keys()).toEqual([`attachments/${another.id}`]);
    expect(await store.clear()).toBe(1);
    expect(blobs.keys()).toEqual([]);
    expect(await store.getMeta(cleared.id)).toBeUndefined();
  });

  it('(c) blob の put が途中で落ちたら、行も blob も残らない', async () => {
    const blobs = new HookedBlobs();
    const store = new PgAttachmentStore(quiet(), { blobs });
    blobs.failPutAfterChunks = 1;
    await expect(
      store.putStream({
        name: 'x.bin',
        mediaType: 'application/octet-stream',
        body: chunks([1], [2], [3]),
      }),
    ).rejects.toThrow('途中で落ちた');
    expect((await client.query(`select id from attachments`)).rows).toEqual([]);
    expect(blobs.keys()).toEqual([]);

    blobs.failPutAfterChunks = 0;
    await expect(
      store.put({ name: 'x.txt', mediaType: 'text/plain', bytes: Buffer.from('abc') }),
    ).rejects.toThrow('途中で落ちた');
    expect((await client.query(`select id from attachments`)).rows).toEqual([]);
  });

  it('(d) INSERT が落ちたら blob を消す', async () => {
    const db = quiet();
    const blobs = new MemoryAttachmentBlobStore();
    const store = new PgAttachmentStore(db, { blobs });
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('INSERT が落ちた');
    });
    await expect(
      store.putStream({
        name: 'x.bin',
        mediaType: 'application/octet-stream',
        body: chunks([1, 2, 3]),
      }),
    ).rejects.toThrow('INSERT が落ちた');
    await expect(
      store.put({ name: 'x.txt', mediaType: 'text/plain', bytes: Buffer.from('abc') }),
    ).rejects.toThrow('INSERT が落ちた');
    expect(blobs.keys()).toEqual([]);
    expect((await client.query(`select id from attachments`)).rows).toEqual([]);
  });

  it('流しながら数える: 上限超え・空・本文が投げた、のどれでも行も blob も残らず、断りの理由はそのまま', async () => {
    const blobs = new HookedBlobs();
    const limits: AttachmentLimits = { ...DEFAULT_ATTACHMENT_LIMITS, maxFileBytes: 4 };
    const store = new PgAttachmentStore(quiet(), { blobs, limits });
    const attempt = (body: AsyncIterable<Uint8Array>) =>
      store.putStream({ name: 'x.bin', mediaType: 'application/octet-stream', body });

    const tooLarge = await attempt(chunks([1, 2, 3], [4, 5])).catch((e: unknown) => e);
    expect(tooLarge).toBeInstanceOf(AttachmentRejectedError);
    expect((tooLarge as AttachmentRejectedError).code).toBe('too_large');

    const empty = await attempt(chunks()).catch((e: unknown) => e);
    expect((empty as AttachmentRejectedError).code).toBe('empty');

    async function* throwing(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([1]);
      throw new Error('本文が投げた');
    }
    await expect(attempt(throwing())).rejects.toThrow('本文が投げた');

    expect(blobs.keys()).toEqual([]);
    expect((await client.query(`select id from attachments`)).rows).toEqual([]);
  });

  it('(e) blob の remove が落ちても行は消え、stderr に1行（件数と理由。key は載せない）', async () => {
    const blobs = new HookedBlobs();
    const store = new PgAttachmentStore(quiet(), { blobs });
    const meta = await store.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('hi'),
    });
    blobs.failRemove = true;
    let removed: boolean | undefined;
    const lines = await captureStderr(async () => {
      removed = await store.remove(meta.id);
    });
    expect(removed).toBe(true);
    expect(await store.getMeta(meta.id)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 件');
    expect(lines[0]).toContain('削除に失敗');
    expect(lines[0]).not.toContain(meta.id);
    expect(blobs.keys()).toHaveLength(1);

    const again = await store.put({
      name: 'b.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('b'),
    });
    const pruneLines = await captureStderr(async () => {
      expect(await store.prune(new Date(Date.now() + 2 * 3_600_000))).toBe(1);
    });
    expect(pruneLines).toHaveLength(1);
    expect(await store.getMeta(again.id)).toBeUndefined();
    await store.put({ name: 'c.txt', mediaType: 'text/plain', bytes: Buffer.from('c') });
    const clearLines = await captureStderr(async () => {
      expect(await store.clear()).toBe(1);
    });
    expect(clearLines).toHaveLength(1);
  });

  it('(f) 大きいファイルの枠: maxFileBytes を超え maxLargeFileBytes 以下が通り、超えると too_large', async () => {
    const limits: AttachmentLimits = {
      ...DEFAULT_ATTACHMENT_LIMITS,
      maxImageBytes: 8,
      maxFileBytes: 4,
      maxLargeFileBytes: 10,
    };
    const store = new PgAttachmentStore(quiet(), {
      blobs: new MemoryAttachmentBlobStore(),
      limits,
    });
    const file = (n: number) => ({
      name: 'x.bin',
      mediaType: 'application/octet-stream',
      body: chunks(Array.from({ length: n }, () => 7)),
    });
    expect((await store.putStream(file(10))).size).toBe(10);
    const over = await store.putStream(file(11)).catch((e: unknown) => e);
    expect((over as AttachmentRejectedError).code).toBe('too_large');
    expect(
      (
        await store.put({
          name: 'y.bin',
          mediaType: 'application/octet-stream',
          bytes: new Uint8Array(10),
        })
      ).size,
    ).toBe(10);
    await expect(
      store.put({
        name: 'z.bin',
        mediaType: 'application/octet-stream',
        bytes: new Uint8Array(11),
      }),
    ).rejects.toMatchObject({ code: 'too_large' });
    const png = Uint8Array.from([...PNG, 0, 0]);
    await expect(
      store.putStream({ name: 'big.png', mediaType: 'image/png', body: chunks([...png]) }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('(g) blobs を外した store は blob_key の行を undefined で返し、stderr に1行出す', async () => {
    const withBlobs = new PgAttachmentStore(quiet(), { blobs: new MemoryAttachmentBlobStore() });
    const meta = await withBlobs.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('hi'),
    });
    const without = new PgAttachmentStore(quiet());
    const lines = await captureStderr(async () => {
      expect(await without.get(meta.id)).toBeUndefined();
      expect(await without.open(meta.id)).toBeUndefined();
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('置き場が設定されていない');
    expect((await without.getMeta(meta.id))?.id).toBe(meta.id);
  });

  it('blobs が無い store は今と同じ（bytes に入り、blob_key は null）', async () => {
    const store = new PgAttachmentStore(quiet());
    const meta = await store.putStream({
      name: 'a.txt',
      mediaType: 'text/plain',
      body: chunks([1, 2]),
    });
    const row = await rowOf(meta.id);
    expect(row?.blob_key).toBeNull();
    expect(row?.bytes).not.toBeNull();
  });
});

describe('migrate（blob_key・bytes の null 許容・置き場の制約。#4128 段2）', () => {
  it('古い形の既存行はそのまま残り、何度走っても落ちない。どちらか一方だけの制約が効く', async () => {
    const db = quiet();
    await client.query(`alter table attachments drop constraint attachments_content_place_chk`);
    await client.query(`alter table attachments drop column blob_key`);
    await client.query(`alter table attachments alter column bytes set not null`);
    await client.query(
      `insert into attachments (id, sha256, media_type, name, size, bytes, created_at, expires_at)
       values ('legacy', 'x', 'text/plain', 'legacy.txt', 3, 'abc', now(), now() + interval '1 day')`,
    );
    await migrate(db);
    await migrate(db);
    const columns = await client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'attachments' and column_name in ('bytes', 'blob_key') order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'blob_key', is_nullable: 'YES' },
      { column_name: 'bytes', is_nullable: 'YES' },
    ]);
    const legacy = await rowOf('legacy');
    expect(legacy?.blob_key).toBeNull();
    expect(legacy?.bytes).not.toBeNull();
    const constraints = await client.query(
      `select conname from pg_constraint where conname = 'attachments_content_place_chk'`,
    );
    expect(constraints.rows).toHaveLength(1);
    const insert = (bytes: string, key: string) =>
      client.query(
        `insert into attachments (id, sha256, media_type, name, size, bytes, blob_key, created_at)
         values ('${bytes}-${key}', 'x', 't', 'n', 1, ${bytes === 'null' ? 'null' : `'a'`}, ${key === 'null' ? 'null' : `'k'`}, now())`,
      );
    await expect(insert('null', 'null')).rejects.toThrow();
    await expect(insert('a', 'k')).rejects.toThrow();
    await insert('null', 'k');
    await insert('a', 'null');
  });
});
