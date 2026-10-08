import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { sha256Hex } from './auth.js';
import type { AttachmentMeta, AttachmentStore } from './attachment.js';
import {
  attachmentCopiesDir,
  fetchAttachmentCopy,
  pruneAttachmentCopies,
} from './attachment-fetch.js';
import { resolveTurnAttachments } from './attachment-turn.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

const BYTES = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

async function toolText(stores: ToolContext['stores'], dir: string, id: string): Promise<string> {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    attachmentCopiesDir: dir,
  };
  const tool = createCloneTools(context).find((t) => t.name === 'attachment_fetch');
  const out = await tool!.handler({ id } as never, {} as never);
  return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

describe('attachment_fetch（#3111 段2）', () => {
  it('置いたファイルの中身が元と一致し、パス・種類・大きさ・sha256 を返す。cwd 配下の置き場に書く', async () => {
    const root = await makeTempDir('alteroid-fetch-');
    const dir = attachmentCopiesDir(root);
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'clip.bin',
      mediaType: 'video/mp4',
      bytes: BYTES,
    });
    const out = await toolText(stores, dir, meta.id);
    const path = join(dir, meta.id, 'clip.bin');
    expect(out).toContain(`path=${path}`);
    expect(out).toContain(`type=video/mp4 size=${BYTES.length} sha256=${meta.sha256}`);
    expect(path.startsWith(root + sep)).toBe(true);
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
  });

  it('同じ sha256 の写しがあれば書き直さず使い回し、違えば書き直す', async () => {
    const root = await makeTempDir('alteroid-fetch-');
    const dir = attachmentCopiesDir(root);
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const first = await fetchAttachmentCopy(stores, dir, meta.id);
    expect(first.ok && first.copy.reused).toBe(false);
    const second = await fetchAttachmentCopy(stores, dir, meta.id);
    expect(second.ok && second.copy.reused).toBe(true);
    const path = join(dir, meta.id, 'a.txt');
    await writeFile(path, 'tampered');
    const third = await fetchAttachmentCopy(stores, dir, meta.id);
    expect(third.ok && third.copy.reused).toBe(false);
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
  });

  it('期限切れ・不在は分かる文で返す（例外にしない）', async () => {
    const dir = await makeTempDir('alteroid-fetch-');
    const stores = createMemoryStores();
    const out = await toolText(stores, dir, 'no-such-id');
    expect(out).toContain('見つからない');
    expect(out).toContain('保持期限');
  });

  it('置き場の失敗は reasonOf を通した文で返す', async () => {
    const dir = await makeTempDir('alteroid-fetch-');
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const out = await toolText(stores, join(blocker, 'sub'), meta.id);
    expect(out).toContain('取り出せなかった');
    expect(out).not.toContain('[object');
  });

  it('置き場が返した id・名前がディレクトリの外へ出る形でも、外へは書かない', async () => {
    const root = await makeTempDir('alteroid-fetch-');
    const dir = join(root, 'copies');
    const evilMeta = (id: string, name: string): AttachmentMeta => ({
      id,
      name,
      mediaType: 'text/plain',
      size: 1,
      sha256: sha256Hex(Uint8Array.from([1])),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1e9).toISOString(),
    });
    const evil = (id: string, name: string) =>
      ({
        get: async () => ({ meta: evilMeta(id, name), bytes: Uint8Array.from([1]) }),
      }) as unknown as AttachmentStore;

    const byId = await fetchAttachmentCopy({ attachments: evil('../escape', 'x') }, dir, 'q');
    expect(byId).toEqual({ ok: false, reason: 'unsafe' });
    const byName = await fetchAttachmentCopy(
      { attachments: evil('abc', '../../escaped.txt') },
      dir,
      'abc',
    );
    expect(byName.ok).toBe(true);
    if (byName.ok)
      expect(resolve(byName.copy.path).startsWith(resolve(dir, 'abc') + sep)).toBe(true);
    await expect(stat(join(root, 'escaped.txt'))).rejects.toThrow();
    await expect(stat(join(root, 'escape'))).rejects.toThrow();
  });

  it('長い名前（ASCII 255 文字・日本語 100 文字）でも写しが作れ、一時ファイルを残さない。返す name は丸めない（#3324）', async () => {
    for (const name of ['a'.repeat(255), `${'あ'.repeat(100)}.pdf`]) {
      const root = await makeTempDir('alteroid-fetch-');
      const stores = createMemoryStores();
      const meta = await stores.attachments.put({
        name,
        mediaType: 'application/pdf',
        bytes: BYTES,
      });
      const out = await fetchAttachmentCopy(stores, root, meta.id);
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.copy.name).toBe(meta.name);
      expect(Buffer.byteLength(basename(out.copy.path), 'utf8')).toBeLessThanOrEqual(200);
      expect(new Uint8Array(await readFile(out.copy.path))).toEqual(BYTES);
      expect(await readdir(join(root, meta.id))).toEqual([basename(out.copy.path)]);
      const again = await fetchAttachmentCopy(stores, root, meta.id);
      expect(again.ok && again.copy.reused).toBe(true);
    }
  });

  it('掃除: 24時間より古い写しと、元が消えた写しを消し、新しくて元がある写しは残す', async () => {
    const root = await makeTempDir('alteroid-fetch-');
    const dir = attachmentCopiesDir(root);
    const stores = createMemoryStores();
    const old = await stores.attachments.put({
      name: 'o.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const fresh = await stores.attachments.put({
      name: 'f.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const orphan = await stores.attachments.put({
      name: 'p.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    for (const m of [old, fresh, orphan]) await fetchAttachmentCopy(stores, dir, m.id);
    const longAgo = new Date(Date.now() - 25 * 3_600_000);
    await utimes(join(dir, old.id), longAgo, longAgo);
    const gone = createMemoryStores();
    await gone.attachments.put({ name: 'x', mediaType: 'text/plain', bytes: BYTES });
    const metaOnly = {
      attachments: {
        getMeta: async (id: string) =>
          id === orphan.id ? undefined : stores.attachments.getMeta(id),
      },
    } as unknown as { attachments: AttachmentStore };
    const removed = await pruneAttachmentCopies(metaOnly, dir, new Date());
    expect(removed).toBe(2);
    await expect(stat(join(dir, old.id))).rejects.toThrow();
    await expect(stat(join(dir, orphan.id))).rejects.toThrow();
    await expect(stat(join(dir, fresh.id, 'f.txt'))).resolves.toBeTruthy();
  });
});

describe('通知行の取り出し案内（#3111 段2）', () => {
  it('画像以外の通知行と、画像の通知行に attachment_fetch の案内が付く（見つからない行には付けない）', async () => {
    const stores = createMemoryStores();
    const txt = await stores.attachments.put({
      name: 'a.log',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const png = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    });
    const ref = (m: AttachmentMeta) => ({
      id: m.id,
      name: m.name,
      mediaType: m.mediaType,
      size: m.size,
      sha256: m.sha256,
    });
    const { noticeLines } = await resolveTurnAttachments(stores, [
      ref(txt),
      ref(png),
      { ...ref(txt), id: 'gone' },
    ]);
    expect(noticeLines[0]).toContain('attachment_fetch');
    expect(noticeLines[0]).toContain('Read');
    expect(noticeLines[1]).toContain('attachment_fetch');
    expect(noticeLines[2]).not.toContain('attachment_fetch');
  });
});

describe('attachment_fetch: 丸めると「..」になる名前（#4072）', () => {
  it('「..」と大量の空白で始まる名前でも unsafe で断らず、file という名前で取り出せる', async () => {
    const root = await makeTempDir('alteroid-fetch-');
    const dir = attachmentCopiesDir(root);
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: `..${' '.repeat(250)}x`,
      mediaType: 'application/octet-stream',
      bytes: BYTES,
    });
    const result = await fetchAttachmentCopy(stores, dir, meta.id);
    expect(result.ok).toBe(true);
    const path = join(dir, meta.id, 'file');
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
  });
});
