import { mkdtemp, readdir, rm, utimes, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATTACHMENT_UNBOUND_TTL_MS, verifyAttachmentStoreContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAttachmentStore } from './attachments.js';

/**
 * 添付ファイルの fs 実装（#3111 段1a）。契約を通し、配置（`<id>/meta.json` と `<id>/data`）・
 * `getMeta` が中身を読まないこと・id でディレクトリの外へ出られないこと・書きかけの残骸の掃除を見る。
 */
let dir: string;
let store: FsAttachmentStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alteroid-attachments-'));
  store = new FsAttachmentStore(join(dir, 'attachments'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

describe('FsAttachmentStore', () => {
  it('契約を通る', async () => {
    await verifyAttachmentStoreContract(store);
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
});
