import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_ORPHAN_BLOB_GRACE_MS,
  MemoryAttachmentBlobStore,
  attachmentBlobKey,
  attachmentBlobListPrefix,
  isAttachmentBlobKey,
} from './attachment-blob.js';
import {
  ATTACHMENT_REQUEST_TIMEOUT_MS,
  DEFAULT_ATTACHMENT_LIMITS,
  prepareAttachment,
} from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

async function* body(): AsyncGenerator<Uint8Array> {
  yield Uint8Array.from([1]);
}

describe('控えの無い blob の掃除の部品（#4314）', () => {
  it('猶予は上げの1リクエストの持ち時間より長い（置いてから INSERT までの blob を消さない）', () => {
    expect(ATTACHMENT_ORPHAN_BLOB_GRACE_MS).toBe(24 * 3_600_000);
    expect(ATTACHMENT_ORPHAN_BLOB_GRACE_MS).toBeGreaterThan(ATTACHMENT_REQUEST_TIMEOUT_MS);
  });

  it('id の正規表現は、置き場が払い出す id（prepareAttachment・randomUUID）の形と同じ', () => {
    for (let i = 0; i < 50; i += 1) expect(randomUUID()).toMatch(ATTACHMENT_ID_PATTERN);
    const meta = prepareAttachment(
      { name: 'a.png', mediaType: 'image/png', bytes: PNG },
      DEFAULT_ATTACHMENT_LIMITS,
      new Date(),
    );
    expect(meta.id).toMatch(ATTACHMENT_ID_PATTERN);
    for (const bad of [
      randomUUID().toUpperCase(),
      `${randomUUID()}x`,
      ` ${randomUUID()}`,
      `${randomUUID()}\n`,
      `${randomUUID()}/x`,
      '',
      'abc',
    ]) {
      expect(bad).not.toMatch(ATTACHMENT_ID_PATTERN);
    }
  });

  it('MemoryAttachmentStore が払い出す id も同じ形', async () => {
    const meta = await new MemoryAttachmentStore().put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
    });
    expect(meta.id).toMatch(ATTACHMENT_ID_PATTERN);
  });

  it('isAttachmentBlobKey は attachmentBlobKey(id, prefix) の形だけを通す', () => {
    const id = randomUUID();
    for (const prefix of ['', 'a/', 'a/b/']) {
      expect(isAttachmentBlobKey(attachmentBlobKey(id, prefix), prefix)).toBe(true);
      expect(attachmentBlobKey('', prefix)).toBe(attachmentBlobListPrefix(prefix));
      expect(isAttachmentBlobKey(`${attachmentBlobKey(id, prefix)}/x`, prefix)).toBe(false);
      expect(isAttachmentBlobKey(attachmentBlobKey(id.toUpperCase(), prefix), prefix)).toBe(false);
    }
    expect(isAttachmentBlobKey(attachmentBlobKey(id, ''), 'a/')).toBe(false);
  });

  it('MemoryAttachmentBlobStore.list は prefix で絞り、置いた時刻を注入した時計から取る', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const blobs = new MemoryAttachmentBlobStore({ now: () => now });
    await blobs.put('a/1', body());
    now = new Date('2026-01-02T00:00:00Z');
    await blobs.put('a/2', body());
    await blobs.put('b/1', body());
    const listed: { key: string; lastModified: Date }[] = [];
    for await (const item of blobs.list('a/')) listed.push(item);
    expect(listed).toEqual([
      { key: 'a/1', lastModified: new Date('2026-01-01T00:00:00Z') },
      { key: 'a/2', lastModified: new Date('2026-01-02T00:00:00Z') },
    ]);
    await blobs.remove(['a/1']);
    const after: string[] = [];
    for await (const item of blobs.list('a/')) after.push(item.key);
    expect(after).toEqual(['a/2']);
  });
});
