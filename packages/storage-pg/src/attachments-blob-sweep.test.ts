import { randomUUID } from 'node:crypto';

import {
  ATTACHMENT_ORPHAN_BLOB_GRACE_MS,
  MemoryAttachmentBlobStore,
  attachmentBlobKey,
} from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PgAttachmentStore } from './attachments.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});
afterEach(async () => {
  await client.close();
});

const quiet = () => client.withLogger({ logQuery: () => undefined });
const NOW = new Date('2026-03-10T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - 100 * 24 * 3_600_000);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

async function* bytes(): AsyncGenerator<Uint8Array> {
  yield Uint8Array.from([1, 2, 3]);
}

async function putOrphan(blobs: MemoryAttachmentBlobStore, key: string, at: Date): Promise<void> {
  await blobs.put(key, bytes());
  blobs.setModified(key, at);
}

describe('PgAttachmentStore.sweepOrphanBlobs（#4314）', () => {
  for (const prefix of ['', 'p/q/']) {
    const label = prefix === '' ? 'prefix 無し' : 'prefix 有り';
    const keyOf = (id: string) => attachmentBlobKey(id, prefix);

    describe(label, () => {
      const setup = () => {
        const blobs = new MemoryAttachmentBlobStore();
        const store = new PgAttachmentStore(quiet(), {
          blobs,
          ...(prefix === '' ? {} : { blobKeyPrefix: prefix }),
        });
        return { blobs, store };
      };
      const oldEnough = new Date(NOW.getTime() - ATTACHMENT_ORPHAN_BLOB_GRACE_MS);

      it('(a) 控えが無く、猶予を過ぎ、形の合う blob は消える', async () => {
        const { blobs, store } = setup();
        const id = randomUUID();
        await putOrphan(blobs, keyOf(id), OLD);
        const result = await store.sweepOrphanBlobs(NOW);
        expect(result).toEqual({ listed: 1, candidates: 1, removed: 1, failed: 0 });
        expect(blobs.keys()).toEqual([]);
      });

      it('(b) 猶予の内は消えない。境界は「ちょうど」が消す側（lastModified + 猶予 <= now）', async () => {
        const { blobs, store } = setup();
        const exact = keyOf(randomUUID());
        const justInside = keyOf(randomUUID());
        await putOrphan(blobs, exact, oldEnough);
        await putOrphan(blobs, justInside, new Date(oldEnough.getTime() + 1));
        const result = await store.sweepOrphanBlobs(NOW);
        expect(result?.removed).toBe(1);
        expect(blobs.keys()).toEqual([justInside]);
        await store.sweepOrphanBlobs(new Date(NOW.getTime() + 1));
        expect(blobs.keys()).toEqual([]);
      });

      it('(c) 控えの在る blob は、どれだけ古くても消えない（期限切れでまだ prune されていない行も）', async () => {
        const { blobs, store } = setup();
        const forever = await new PgAttachmentStore(quiet(), {
          blobs,
          now: () => OLD,
          ...(prefix === '' ? {} : { blobKeyPrefix: prefix }),
        }).put({ name: 'k.png', mediaType: 'image/png', bytes: PNG, kept: true });
        const expired = await new PgAttachmentStore(quiet(), {
          blobs,
          now: () => OLD,
          ...(prefix === '' ? {} : { blobKeyPrefix: prefix }),
        }).put({ name: 'e.png', mediaType: 'image/png', bytes: PNG });
        const rows = await client.query<{ n: number }>(
          `select count(*)::int as n from attachments where expires_at < '${NOW.toISOString()}'`,
        );
        expect(rows.rows[0]?.n).toBe(1);
        for (const meta of [forever, expired]) blobs.setModified(keyOf(meta.id), OLD);
        const result = await store.sweepOrphanBlobs(NOW);
        expect(result).toEqual({ listed: 2, candidates: 0, removed: 0, failed: 0 });
        expect(blobs.keys().sort()).toEqual([keyOf(forever.id), keyOf(expired.id)].sort());
      });

      it('(d) 形の合わない key は、どれだけ古くても消えない', async () => {
        const { blobs, store } = setup();
        const id = randomUUID();
        const keep = [
          `${prefix}attachments/${id}/nested`,
          `${prefix}attachments/nested/${id}`,
          `${prefix}attachments/other-name`,
          `${prefix}attachments/${id.toUpperCase()}`,
          `${prefix}attachments/${id}.bak`,
          `${prefix}attachments/${id} `,
          `${prefix}attachments/`,
          `${prefix}attachments`,
          `${prefix}attachments-x/${id}`,
          `${prefix}other/attachments/${id}`,
          `other/${prefix}attachments/${id}`,
          `${prefix}${id}`,
          `x/${prefix}attachments/${id}`,
        ];
        if (prefix !== '') keep.push(`attachments/${id}`, `p/attachments/${id}`);
        for (const key of keep) await putOrphan(blobs, key, OLD);
        const result = await store.sweepOrphanBlobs(NOW);
        expect(result?.removed).toBe(0);
        expect(result?.candidates).toBe(0);
        expect(blobs.keys().sort()).toEqual([...new Set(keep)].sort());
      });

      it('(f) 削除に落ちたら、投げずに failed に数える', async () => {
        const { blobs, store } = setup();
        const key = keyOf(randomUUID());
        await putOrphan(blobs, key, OLD);
        blobs.remove = async () => {
          throw new Error('削除を断られた');
        };
        const result = await store.sweepOrphanBlobs(NOW);
        expect(result).toMatchObject({ listed: 1, candidates: 1, removed: 0, failed: 1 });
        expect(result?.reason).toContain('削除を断られた');
        expect(result?.reason).not.toContain(key);
        expect(blobs.keys()).toEqual([key]);
      });

      it('列挙が落ちたら投げる', async () => {
        const { blobs, store } = setup();
        // eslint-disable-next-line require-yield
        blobs.list = async function* () {
          throw new Error('列挙が落ちた');
        };
        await expect(store.sweepOrphanBlobs(NOW)).rejects.toThrow('列挙が落ちた');
      });

      it('(g) 500件を超える束をまたいでも、控えの在るものを消さず、無いものだけ消す', async () => {
        const { blobs, store } = setup();
        const writer = new PgAttachmentStore(quiet(), {
          blobs,
          now: () => OLD,
          ...(prefix === '' ? {} : { blobKeyPrefix: prefix }),
        });
        const referenced: string[] = [];
        const orphans: string[] = [];
        const addReferenced = async (): Promise<void> => {
          const meta = await writer.put({
            name: 'r.png',
            mediaType: 'image/png',
            bytes: PNG,
            kept: true,
          });
          blobs.setModified(keyOf(meta.id), OLD);
          referenced.push(keyOf(meta.id));
        };
        await addReferenced();
        for (let i = 0; i < 1100; i += 1) {
          if (i === 400 || i === 600 || i === 1000) await addReferenced();
          const key = keyOf(randomUUID());
          await putOrphan(blobs, key, OLD);
          orphans.push(key);
        }
        await addReferenced();
        const result = await store.sweepOrphanBlobs(NOW);
        expect(result).toEqual({ listed: 1105, candidates: 1100, removed: 1100, failed: 0 });
        expect(blobs.keys().sort()).toEqual([...referenced].sort());
      }, 60_000);
    });
  }

  it('(e) blobs が無い store は undefined を返し、何も出さない', async () => {
    const store = new PgAttachmentStore(quiet());
    expect(await store.sweepOrphanBlobs(NOW)).toBeUndefined();
  });
});
