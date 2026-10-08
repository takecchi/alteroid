import { mkdir, readdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { fetchAttachmentCopy, pruneAttachmentCopies } from './attachment-fetch.js';
import { createMemoryStores } from './testing.js';

const hooks = vi.hoisted(() => ({
  afterStat: undefined as undefined | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      const hook = hooks.afterStat;
      if (hook !== undefined) {
        hooks.afterStat = undefined;
        await hook();
      }
      return result;
    }) as typeof actual.stat,
  };
});

afterEach(() => {
  hooks.afterStat = undefined;
});

describe('写しの掃除と取り出しの競り', () => {
  it('掃除が「古い」と判定したあとに取り出し（使い回し）が走ったら、返したパスの写しを消さない', async () => {
    const copiesDir = await makeTempDir('alteroid-copies-toctou-');
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'clip.bin',
      mediaType: 'application/octet-stream',
      bytes: Uint8Array.from([1, 2, 3]),
    });
    await fetchAttachmentCopy(stores, copiesDir, meta.id);
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(join(copiesDir, meta.id), old, old);
    let returned: string | undefined;
    hooks.afterStat = async () => {
      const out = await fetchAttachmentCopy(stores, copiesDir, meta.id);
      if (out.ok) returned = out.copy.path;
    };
    await pruneAttachmentCopies(stores, copiesDir, new Date());
    expect(returned).toBeDefined();
    await expect(stat(returned as string)).resolves.toBeTruthy();
  });

  it('古いまま使われなかった写しは消す。前の周で残った掃除専用の名前も消す', async () => {
    const copiesDir = await makeTempDir('alteroid-copies-toctou-');
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'clip.bin',
      mediaType: 'application/octet-stream',
      bytes: Uint8Array.from([1, 2, 3]),
    });
    await fetchAttachmentCopy(stores, copiesDir, meta.id);
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(join(copiesDir, meta.id), old, old);
    await mkdir(join(copiesDir, '.pruning-leftover'));
    expect(await pruneAttachmentCopies(stores, copiesDir, new Date())).toBe(1);
    expect(await readdir(copiesDir)).toEqual([]);
  });
});
