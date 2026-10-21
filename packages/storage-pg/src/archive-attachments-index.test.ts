import { randomUUID } from 'node:crypto';

import {
  ATTACHMENT_ORPHAN_BLOB_GRACE_MS,
  MemoryAttachmentBlobStore,
  attachmentBlobKey,
} from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PgTranscriptArchive } from './archive.js';
import { PgAttachmentStore } from './attachments.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 頻度は低いが、問い合わせの形に合う索引が無かった2つ（#5140）

let client: TestDbHandle;

beforeEach(async () => {
  ({ client } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

type Captured = { sql: string; params: unknown[] };

function capturing(): { db: ReturnType<TestDbHandle['withLogger']>; queries: Captured[] } {
  const queries: Captured[] = [];
  const db = client.withLogger({
    logQuery: (text, params) => {
      queries.push({ sql: text, params });
    },
  });
  return { db, queries };
}

function inline(query: Captured): string {
  return query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = query.params[Number(index) - 1];
    return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  });
}

// 順の走査を禁じて計画を取る: 測りたいのは「索引の形が読み出しの絞りに合っているか」で、小さい表では順に読む方が安いと見積もられ、合っていても索引が選ばれないため
async function planOf(query: Captured): Promise<string> {
  await client.exec('set enable_seqscan = off');
  const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inline(query)}`)).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  await client.exec('reset enable_seqscan');
  return plan;
}

describe('archive_session_at_idx（#5140）', () => {
  it('⭐ archive() が「同じセッションの直前の行」を引く SQL の計画が、外側も max(at) もこの索引に乗る', async () => {
    const { db, queries } = capturing();
    const archive = new PgTranscriptArchive(db);
    for (const session of ['sess-a', 'sess-b', 'sess-c']) {
      await archive.archive(session, `${session} の1本目`);
      await archive.archive(session, `${session} の1本目\n2本目`);
    }

    const query = queries.findLast(
      (entry) => entry.sql.includes('max(') && entry.sql.includes('"archive"'),
    );
    if (query === undefined) throw new Error('直前の行を引く SQL を捕まえられなかった');
    const plan = await planOf(query);
    expect(plan).toContain('archive_session_at_idx');
    expect(plan).not.toMatch(/Seq Scan on archive/);
  });
});

describe('attachments_blob_key_idx（#5140）', () => {
  it('⭐ 孤児の掃除が blob_key を束で引く SQL の計画が、この部分索引に乗る', async () => {
    const blobs = new MemoryAttachmentBlobStore();
    const { db, queries } = capturing();
    const now = new Date('2026-03-10T00:00:00.000Z');
    const old = new Date(now.getTime() - ATTACHMENT_ORPHAN_BLOB_GRACE_MS - 1);
    const writer = new PgAttachmentStore(db, { blobs, now: () => old });
    const kept = await writer.put({
      name: 'k.png',
      mediaType: 'image/png',
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]),
      kept: true,
    });
    blobs.setModified(attachmentBlobKey(kept.id), old);
    const orphan = attachmentBlobKey(randomUUID());
    await blobs.put(
      orphan,
      (async function* () {
        yield Uint8Array.from([1, 2, 3]);
      })(),
    );
    blobs.setModified(orphan, old);

    const result = await new PgAttachmentStore(db, { blobs }).sweepOrphanBlobs(now);
    expect(result).toMatchObject({ removed: 1 });

    const query = queries.findLast((entry) => /"blob_key" in \(/.test(entry.sql));
    if (query === undefined) throw new Error('blob_key を束で引く SQL を捕まえられなかった');
    const plan = await planOf(query);
    expect(plan).toContain('attachments_blob_key_idx');
  });
});
