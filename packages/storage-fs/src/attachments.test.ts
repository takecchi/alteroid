import { readdir, rm, utimes, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ATTACHMENT_UNBOUND_TTL_MS, verifyAttachmentStoreContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { FsAttachmentStore } from './attachments.js';

/**
 * 順序を作るためのフック（実時間の待ちは使わない）。`readFile` は meta.json を読み終えた直後に1度だけ
 * `afterMetaRead` を呼び、`rm` は `rmFails` に入っているパスで失敗させる。どちらも既定では素通し。
 */
const hooks = vi.hoisted(() => ({
  afterMetaRead: undefined as undefined | (() => Promise<void>),
  rmFails: new Set<string>(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      const hook = hooks.afterMetaRead;
      if (hook !== undefined && String(args[0]).endsWith('meta.json')) {
        hooks.afterMetaRead = undefined;
        await hook();
      }
      return result;
    }) as typeof actual.readFile,
    rm: (async (...args: Parameters<typeof actual.rm>) => {
      if (hooks.rmFails.has(String(args[0]))) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return actual.rm(...args);
    }) as typeof actual.rm,
  };
});

/**
 * 添付ファイルの fs 実装（#3111 段1a）。契約を通し、配置（`<id>/meta.json` と `<id>/data`）・
 * `getMeta` が中身を読まないこと・id でディレクトリの外へ出られないこと・書きかけの残骸の掃除を見る。
 */
let dir: string;
let store: FsAttachmentStore;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-attachments-');
  store = new FsAttachmentStore(join(dir, 'attachments'));
});
afterEach(async () => {
  hooks.afterMetaRead = undefined;
  hooks.rmFails.clear();
  await rm(dir, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

describe('FsAttachmentStore', () => {
  it('契約を通る', async () => {
    let created = 0;
    await verifyAttachmentStoreContract(store, {
      createStore: (options) =>
        new FsAttachmentStore(join(dir, `contract-${(created += 1)}`), options),
    });
  });

  it('<id>/meta.json と <id>/data の形で置く', async () => {
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    expect((await readdir(join(dir, 'attachments', meta.id))).sort()).toEqual([
      'data',
      'meta.json',
    ]);
    expect(Array.from(await readFile(join(dir, 'attachments', meta.id, 'data')))).toEqual(
      Array.from(PNG),
    );
    expect(
      JSON.parse(await readFile(join(dir, 'attachments', meta.id, 'meta.json'), 'utf8')).sha256,
    ).toBe(meta.sha256);
  });

  it('getMeta は data を読まない（data を消しても控えは返り、get は無いと答える）', async () => {
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    await rm(join(dir, 'attachments', meta.id, 'data'));
    expect(await store.getMeta(meta.id)).toEqual(meta);
    expect(await store.get(meta.id)).toBeUndefined();
  });

  it('UUID でない id（../ など）は無いと答え、外のファイルを読まない', async () => {
    await writeFile(join(dir, 'secret'), 'x');
    expect(await store.getMeta('../secret')).toBeUndefined();
    expect(await store.get('..')).toBeUndefined();
    expect((await store.bind(['../secret'], 'c')).missing).toEqual(['../secret']);
  });

  it('prune は控えの無い書きかけを、1時間たってから片付ける', async () => {
    const orphan = join(dir, 'attachments', '11111111-1111-4111-8111-111111111111');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'data'), 'half');
    const now = new Date();
    expect(await store.prune(now)).toBe(0);
    const old = new Date(now.getTime() - ATTACHMENT_UNBOUND_TTL_MS - 60_000);
    await utimes(orphan, old, old);
    expect(await store.prune(now)).toBe(1);
    expect(await readdir(join(dir, 'attachments'))).toEqual([]);
  });

  it('prune が読んだあとに bind が通っても、結び付いた添付を消さない（判定し直してから消す）', async () => {
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const later = new Date(Date.now() + ATTACHMENT_UNBOUND_TTL_MS + 60_000);
    // prune が未結び付けと読んだ直後（rm の前）に bind を割り込ませる。
    hooks.afterMetaRead = async () => {
      await store.bind([meta.id], 'conv-1');
    };
    expect(await store.prune(later)).toBe(0);
    expect((await store.getMeta(meta.id))?.conversationId).toBe('conv-1');
    expect(await store.get(meta.id)).toBeDefined();
  });

  it('prune は1件の rm が失敗しても残りを掃き、消せた件数だけを返す', async () => {
    const ids = [
      (await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG })).id,
      (await store.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG })).id,
      (await store.put({ name: 'c.png', mediaType: 'image/png', bytes: PNG })).id,
    ].sort();
    const later = new Date(Date.now() + ATTACHMENT_UNBOUND_TTL_MS + 60_000);
    hooks.rmFails.add(join(dir, 'attachments', ids[0] as string));
    expect(await store.prune(later)).toBe(2);
    expect(await readdir(join(dir, 'attachments'))).toEqual([ids[0]]);
    hooks.rmFails.clear();
    expect(await store.prune(later)).toBe(1);
  });

  it('壊れた meta.json（JSON でない・形が違う）は「無い」と答え、bind は missing、prune は1時間たってから片付ける', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - ATTACHMENT_UNBOUND_TTL_MS - 60_000);
    const broken = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const bodies = ['{"id": "truncated', JSON.stringify({ id: 1, name: 'x' })];
    for (const [index, id] of broken.entries()) {
      const orphan = join(dir, 'attachments', id);
      await mkdir(orphan, { recursive: true });
      await writeFile(join(orphan, 'meta.json'), bodies[index] as string);
      await writeFile(join(orphan, 'data'), 'whatever');
      expect(await store.getMeta(id)).toBeUndefined();
      expect(await store.get(id)).toBeUndefined();
      expect((await store.bind([id], 'c')).missing).toEqual([id]);
    }
    // bind の試みは meta.json.lock を置くが、1時間たつ前には何も消えない。
    expect(await store.prune(now)).toBe(0);
    for (const id of broken) await utimes(join(dir, 'attachments', id), old, old);
    expect(await store.prune(now)).toBe(2);
    expect(await readdir(join(dir, 'attachments'))).toEqual([]);
  });

  it('書きかけの data.tmp.*（put の途中で落ちた残骸）は預かった扱いにならず、1時間たってから片付く', async () => {
    const now = new Date();
    const id = '44444444-4444-4444-8444-444444444444';
    const orphan = join(dir, 'attachments', id);
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'data.tmp.123.abcd1234'), 'half');
    expect(await store.getMeta(id)).toBeUndefined();
    expect(await store.get(id)).toBeUndefined();
    expect(await store.prune(now)).toBe(0);
    const old = new Date(now.getTime() - ATTACHMENT_UNBOUND_TTL_MS - 60_000);
    await utimes(orphan, old, old);
    expect(await store.prune(now)).toBe(1);
    expect(await readdir(join(dir, 'attachments'))).toEqual([]);
  });

  it('控えのある添付に data.tmp.* が残っていても get は中身を返し、期限が来れば残骸ごと消える', async () => {
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    await writeFile(join(dir, 'attachments', meta.id, 'data.tmp.999.deadbeef'), 'half');
    expect(Array.from((await store.get(meta.id))?.bytes ?? [])).toEqual(Array.from(PNG));
    await store.bind([meta.id], 'conv-1');
    expect(await store.prune(new Date(Date.parse(meta.expiresAt)))).toBe(1);
    expect(await readdir(join(dir, 'attachments'))).toEqual([]);
  });
});
