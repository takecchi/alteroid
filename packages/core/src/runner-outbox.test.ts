import { createHash } from 'node:crypto';
import {
  appendFile,
  link,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  collectManagerOutbox,
  openStagedOutboxFile,
  prepareManagerOutbox,
  pruneStaleOutboxRoots,
  removeManagerOutbox,
  removeStagedOutboxFile,
} from './runner-outbox.js';

const MANAGER = 'mgr-abc123';
const LIMITS = { maxFileBytes: 1024, maxPerMessage: 3, maxTotalBytes: 2048 };

async function setup() {
  const root = await makeTempDir('runner-outbox-');
  const stagedRoot = await makeTempDir('runner-outbox-staged-');
  const outside = await makeTempDir('runner-outbox-outside-');
  const dir = prepareManagerOutbox({ root, managerId: MANAGER });
  const collect = (overrides: Partial<Parameters<typeof collectManagerOutbox>[0]> = {}) =>
    collectManagerOutbox({
      root,
      stagedRoot,
      managerId: MANAGER,
      expectedUid: process.getuid?.(),
      limits: LIMITS,
      ...overrides,
    });
  return { root, stagedRoot, outside, dir, collect };
}

describe('prepareManagerOutbox の権限', () => {
  it('降ろさない構成は root 0711・出し箱 0700', async () => {
    const { root, dir } = await setup();
    expect((await stat(root)).mode & 0o7777).toBe(0o711);
    expect((await stat(dir)).mode & 0o7777).toBe(0o700);
  });

  it('子の gid を渡すと出し箱は 02770 でグループが子の gid になる', async () => {
    const root = await makeTempDir('runner-outbox-');
    const gid = process.getgid?.() ?? 0;
    const dir = prepareManagerOutbox({ root, managerId: MANAGER, childGid: gid });
    const info = await stat(dir);
    expect(info.mode & 0o7777).toBe(0o2770);
    expect(info.gid).toBe(gid);
  });

  it('root が symlink なら用意しない', async () => {
    const parent = await makeTempDir('runner-outbox-');
    const target = await makeTempDir('runner-outbox-target-');
    await symlink(target, join(parent, 'box'));
    expect(() => prepareManagerOutbox({ root: join(parent, 'box'), managerId: MANAGER })).toThrow(
      /実在の dir でない/,
    );
    expect(await readdir(target)).toEqual([]);
  });
});

describe('collectManagerOutbox', () => {
  it('取り込んだ分は sha256・大きさが合い、退避先は 0400（dir 0700）、出し箱の名前は消え、次の報告で二重に出ない', async () => {
    const { dir, stagedRoot, collect } = await setup();
    const body = Buffer.from('成果物の中身');
    await writeFile(join(dir, 'result.txt'), body);
    const first = await collect();
    expect(first.rejectedFiles).toEqual([]);
    expect(first.files).toHaveLength(1);
    const file = first.files[0]!;
    expect(file).toMatchObject({
      name: 'result.txt',
      mediaType: 'text/plain',
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect(file.fileId).toMatch(/^[0-9a-f]{32}$/);
    const staged = join(stagedRoot, MANAGER, file.fileId);
    expect(await readFile(staged)).toEqual(body);
    expect((await stat(staged)).mode & 0o777).toBe(0o400);
    expect((await stat(join(stagedRoot, MANAGER))).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual([]);
    expect(await collect()).toEqual({ files: [], rejectedFiles: [] });
  });

  it('拡張子が不明なら application/octet-stream', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'blob.bin2'), 'x');
    expect((await collect()).files[0]?.mediaType).toBe('application/octet-stream');
  });

  it('出し箱の外のファイルを指す symlink は断り、中身を退避先へ写さず、リンク先を消さない', async () => {
    const { dir, outside, stagedRoot, collect } = await setup();
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'runner の持ち物');
    await symlink(secret, join(dir, 'leak.txt'));
    const result = await collect();
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles).toEqual([
      { name: 'leak.txt', reason: expect.stringContaining('symlink') },
    ]);
    expect(await readFile(secret, 'utf8')).toBe('runner の持ち物');
    const stagedNames = await readdir(join(stagedRoot, MANAGER)).catch(() => []);
    expect(stagedNames).toEqual([]);
    await expect(lstat(join(dir, 'leak.txt'))).rejects.toThrow();
  });

  it('所有者が期待する uid と違えば断る（期待 uid を差し替えて不一致を作る）', async () => {
    const { dir, stagedRoot, collect } = await setup();
    await writeFile(join(dir, 'a.txt'), 'x');
    const result = await collect({ expectedUid: (process.getuid?.() ?? 0) + 1 });
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles[0]?.reason).toContain('所有者');
    expect(await readdir(join(stagedRoot, MANAGER))).toEqual([]);
  });

  it('ハードリンク（runner の持ち物を指させる形）を断り、元のファイルは残る', async () => {
    const { dir, outside, collect } = await setup();
    const original = join(outside, 'owned.txt');
    await writeFile(original, 'runner の持ち物');
    await link(original, join(dir, 'hard.txt'));
    const result = await collect();
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles[0]?.reason).toContain('ハードリンク');
    expect(await readFile(original, 'utf8')).toBe('runner の持ち物');
  });

  it('FIFO を置いても詰まらずに断る', async () => {
    const { dir, collect } = await setup();
    execFileSync('mkfifo', [join(dir, 'pipe')], { env: { PATH: '/usr/bin:/bin' } });
    const result = await collect();
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles).toEqual([
      { name: 'pipe', reason: expect.stringContaining('通常のファイルではない') },
    ]);
  });

  it('サブディレクトリは辿らずに断る（中身も取り込まない・消さない）', async () => {
    const { dir, collect } = await setup();
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'inner.txt'), 'x');
    const result = await collect();
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles[0]).toMatchObject({ name: 'sub' });
    expect(await readdir(join(dir, 'sub'))).toEqual(['inner.txt']);
  });

  it('1つの上限を超えるものは断る', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(LIMITS.maxFileBytes + 1));
    const result = await collect();
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles[0]?.reason).toContain('1つの上限');
  });

  it('個数の上限を超えた分は名前の昇順で先着を通し、残りは出し箱に残して次の報告で送る', async () => {
    const { dir, collect } = await setup();
    for (const name of ['d.txt', 'a.txt', 'c.txt', 'b.txt']) await writeFile(join(dir, name), name);
    const first = await collect();
    expect(first.files.map((f) => f.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(first.rejectedFiles).toEqual([
      { name: 'd.txt', reason: expect.stringContaining('個数') },
    ]);
    expect((await collect()).files.map((f) => f.name)).toEqual(['d.txt']);
  });

  it('合計の上限を超えた分は断って残す', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'a.bin'), Buffer.alloc(1024));
    await writeFile(join(dir, 'b.bin'), Buffer.alloc(1024));
    await writeFile(join(dir, 'c.bin'), Buffer.alloc(10));
    const result = await collect();
    expect(result.files.map((f) => f.name)).toEqual(['a.bin', 'b.bin']);
    expect(result.rejectedFiles[0]).toMatchObject({ name: 'c.bin' });
    expect(await readdir(dir)).toEqual(['c.bin']);
  });

  it('読んでいる間に大きさが変わったら断って退避先を消す', async () => {
    const { dir, stagedRoot, collect } = await setup();
    const path = join(dir, 'grow.bin');
    await writeFile(path, Buffer.alloc(100_000));
    const result = await collect({
      limits: { ...LIMITS, maxFileBytes: 200_000, maxTotalBytes: 200_000 },
      afterFirstChunk: () => appendFile(path, 'x'),
    });
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles[0]?.reason).toContain('大きさが変わった');
    expect(await readdir(join(stagedRoot, MANAGER))).toEqual([]);
  });
});

describe('退避先の取得・削除・掃除', () => {
  it('開いて中身が取れ、消すと開けず、無くても消せる。不正な id は開かない', async () => {
    const { dir, stagedRoot, collect } = await setup();
    await writeFile(join(dir, 'a.txt'), 'hello');
    const { fileId } = (await collect()).files[0]!;
    const opened = await openStagedOutboxFile(stagedRoot, MANAGER, fileId);
    expect(opened?.size).toBe(5);
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(await openStagedOutboxFile(stagedRoot, MANAGER, '../../etc/passwd')).toBeUndefined();
    expect(await removeStagedOutboxFile(stagedRoot, MANAGER, '../x')).toBe(false);
    expect(await removeStagedOutboxFile(stagedRoot, MANAGER, fileId)).toBe(true);
    expect(await removeStagedOutboxFile(stagedRoot, MANAGER, fileId)).toBe(true);
    expect(await openStagedOutboxFile(stagedRoot, MANAGER, fileId)).toBeUndefined();
  });

  it('removeManagerOutbox は出し箱だけを消し（降ろさない構成）、退避先は残る', async () => {
    const { root, dir, stagedRoot, collect } = await setup();
    await writeFile(join(dir, 'a.txt'), 'x');
    await mkdir(join(dir, 'sub'));
    const { files } = await collect();
    removeManagerOutbox(root, MANAGER);
    await expect(stat(join(root, MANAGER))).rejects.toThrow();
    expect(await readdir(join(stagedRoot, MANAGER))).toEqual([files[0]!.fileId]);
  });

  it('子を降ろす構成では、出し箱の中身を runner の権限で再帰削除せず、子の権限の削除関数へ渡す', async () => {
    const { root, dir, outside } = await setup();
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'inner.txt'), 'x');
    await symlink(outside, join(dir, 'link'));
    const calls: { entries: string[]; child: { uid: number; gid: number } }[] = [];
    const child = { uid: 4242, gid: 4343 };
    removeManagerOutbox(root, MANAGER, {
      child,
      removeContentsAsChild: (entries, given) =>
        calls.push({ entries: [...entries], child: given }),
    });
    expect(calls).toEqual([{ entries: [join(dir, 'link'), join(dir, 'sub')], child }]);
    expect(await readFile(join(dir, 'sub', 'inner.txt'), 'utf8')).toBe('x');
    expect((await lstat(join(dir, 'link'))).isSymbolicLink()).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  it('子の権限の削除が中身を消し終えたら、runner は空の出し箱 dir を rmdir する', async () => {
    const { root, dir } = await setup();
    await mkdir(join(dir, 'sub'));
    removeManagerOutbox(root, MANAGER, {
      child: { uid: 1, gid: 1 },
      removeContentsAsChild: (entries) => {
        for (const entry of entries) rmSync(entry, { recursive: true });
      },
    });
    await expect(stat(dir)).rejects.toThrow();
  });

  it('古い取りこぼしの掃除: 出し箱の root は子の権限の削除関数、退避先の root は再帰削除', async () => {
    const { root, stagedRoot } = await setup();
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const top of [root, stagedRoot]) {
      await mkdir(join(top, 'mgr-old', 'sub'), { recursive: true });
      await utimes(join(top, 'mgr-old'), old, old);
    }
    const calls: string[][] = [];
    pruneStaleOutboxRoots({ outboxRoot: root, stagedRoot }, [], Date.now(), {
      child: { uid: 1, gid: 1 },
      removeContentsAsChild: (entries) => calls.push([...entries]),
    });
    expect(calls).toEqual([[join(root, 'mgr-old', 'sub')]]);
    expect((await readdir(join(root, 'mgr-old'))).length).toBe(1);
    await expect(stat(join(stagedRoot, 'mgr-old'))).rejects.toThrow();
    await mkdir(join(stagedRoot, 'mgr-live'));
    await utimes(join(stagedRoot, 'mgr-live'), old, old);
    pruneStaleOutboxRoots({ outboxRoot: root, stagedRoot }, ['mgr-live'], Date.now());
    expect((await stat(join(stagedRoot, 'mgr-live'))).isDirectory()).toBe(true);
  });
});
