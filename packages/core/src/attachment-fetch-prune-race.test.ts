import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { fetchAttachmentCopy, pruneAttachmentCopies } from './attachment-fetch.js';
import { createMemoryStores } from './testing.js';

/**
 * 写しの使い回しと掃除の競り合い・掃除の1件ごとの失敗（#3329）。順序はフックで作る（実時間の待ちは使わない）。
 * `utimes`（使い回しの「使われた印」）の直前に `beforeUtimes` を1度だけ呼び、`rm` は `rmFails` のパスで失敗させる。
 */
const hooks = vi.hoisted(() => ({
  beforeUtimes: undefined as undefined | (() => Promise<void>),
  rmFails: new Set<string>(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    utimes: (async (...args: Parameters<typeof actual.utimes>) => {
      const hook = hooks.beforeUtimes;
      if (hook !== undefined) {
        hooks.beforeUtimes = undefined;
        await hook();
      }
      return actual.utimes(...args);
    }) as typeof actual.utimes,
    rm: (async (...args: Parameters<typeof actual.rm>) => {
      if (hooks.rmFails.has(String(args[0]))) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return actual.rm(...args);
    }) as typeof actual.rm,
  };
});

afterEach(() => {
  hooks.beforeUtimes = undefined;
  hooks.rmFails.clear();
});

const BYTES = Uint8Array.from([0, 1, 2, 250, 251]);

describe('写しの使い回しと掃除（#3329）', () => {
  it('使い回す途中で掃除が写しを消しても、消えたパスを返さず書き直す', async () => {
    const copiesDir = await makeTempDir('alteroid-copies-race-');
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'clip.bin',
      mediaType: 'application/octet-stream',
      bytes: BYTES,
    });
    await fetchAttachmentCopy(stores, copiesDir, meta.id);
    // 既存の写しを確かめたあと、使われた印を付ける前に、掃除が写しのディレクトリごと消す。
    hooks.beforeUtimes = async () => {
      const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await rm(join(copiesDir, meta.id), { recursive: true, force: true });
    };
    const out = await fetchAttachmentCopy(stores, copiesDir, meta.id);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await expect(stat(out.copy.path)).resolves.toBeTruthy();
  });

  it('pruneAttachmentCopies は1件の rm が失敗しても残りを掃き、消せた件数を返す', async () => {
    const copiesDir = await makeTempDir('alteroid-copies-prune-');
    const stores = createMemoryStores();
    const ids = ['aaa', 'bbb', 'ccc'];
    for (const id of ids) {
      await mkdir(join(copiesDir, id));
      await writeFile(join(copiesDir, id, 'f'), 'x');
      const old = new Date(Date.now() - 48 * 3_600_000);
      await utimes(join(copiesDir, id), old, old);
    }
    hooks.rmFails.add(join(copiesDir, 'aaa'));
    expect(await pruneAttachmentCopies(stores, copiesDir, new Date())).toBe(2);
    expect((await readdir(copiesDir)).sort()).toEqual(['aaa']);
  });
});
