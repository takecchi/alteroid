import { execFileSync } from 'node:child_process';
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { attachToManagerOutbox } from './runner-outbox-attach.js';
import { collectManagerOutbox, prepareManagerOutbox } from './runner-outbox.js';

const MANAGER = 'mgr-abcd1234-0000';
const SCRATCH_NAME = 'mgr-abcd1234';
const LIMITS = { maxFileBytes: 1024, maxPerMessage: 3, maxTotalBytes: 2048 };

async function setup() {
  const outboxRoot = await makeTempDir('attach-outbox-');
  const stagedRoot = await makeTempDir('attach-staged-');
  const scratchParent = await makeTempDir('attach-tmp-');
  const cwd = await makeTempDir('attach-cwd-');
  const outside = await makeTempDir('attach-outside-');
  const dir = prepareManagerOutbox({ root: outboxRoot, managerId: MANAGER });
  const scratch = join(scratchParent, SCRATCH_NAME);
  await mkdir(scratch);
  const attach = (
    paths: string[],
    overrides: Partial<Parameters<typeof attachToManagerOutbox>[0]> = {},
  ) =>
    attachToManagerOutbox({
      outboxRoot,
      managerId: MANAGER,
      scratchParent,
      scratchName: SCRATCH_NAME,
      expectedUid: process.getuid?.(),
      limits: LIMITS,
      // 大きいファイルは受けない前提（env の既定 2 GiB に依らない）
      maxLargeFileBytes: LIMITS.maxFileBytes,
      paths,
      ...overrides,
    });
  return { outboxRoot, stagedRoot, scratchParent, scratch, cwd, outside, dir, attach };
}

const refusal = (results: Awaited<ReturnType<typeof attachToManagerOutbox>>, index = 0): string => {
  const result = results[index];
  if (result === undefined || result.ok) throw new Error('断られていない');
  return result.reason;
};

describe('attachToManagerOutbox: 写せるもの', () => {
  it('作業場・作業場の別名（-*）の下のファイルを出し箱の直下へ写し、1件ずつ名前と大きさを返す', async () => {
    const { scratchParent, scratch, dir, attach } = await setup();
    await mkdir(join(scratch, 'sub'));
    await mkdir(join(scratchParent, `${SCRATCH_NAME}-wt1`));
    await writeFile(join(scratch, 'sub', 'a.txt'), 'aaaa');
    await writeFile(join(scratchParent, `${SCRATCH_NAME}-wt1`, 'b.md'), 'bb');

    const results = await attach([
      join(scratch, 'sub', 'a.txt'),
      join(scratchParent, `${SCRATCH_NAME}-wt1`, 'b.md'),
    ]);

    expect(results).toEqual([
      { path: join(scratch, 'sub', 'a.txt'), ok: true, name: 'a.txt', size: 4 },
      { path: join(scratchParent, `${SCRATCH_NAME}-wt1`, 'b.md'), ok: true, name: 'b.md', size: 2 },
    ]);
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'b.md']);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('aaaa');
    // 元のファイルは残る（写すだけ）
    expect(await readFile(join(scratch, 'sub', 'a.txt'), 'utf8')).toBe('aaaa');
  });

  it('⭐ 他の担当のファイルは写せない: 共有の cwd の下と、他の担当の作業場（別の先頭8桁）の下は、持ち主が同じでも断る', async () => {
    const { scratchParent, cwd, dir, attach } = await setup();
    // 共有の cwd（他の担当のチェックアウトが在りうる）
    await writeFile(join(cwd, 'others.csv'), 'c');
    // 他の担当の作業場
    const otherScratch = join(scratchParent, 'mgr-ffffffff');
    await mkdir(otherScratch);
    await writeFile(join(otherScratch, 'secret.txt'), 's');
    await mkdir(join(scratchParent, 'mgr-ffffffff-wt1'));
    await writeFile(join(scratchParent, 'mgr-ffffffff-wt1', 'b.txt'), 'b');

    const results = await attach([
      join(cwd, 'others.csv'),
      join(otherScratch, 'secret.txt'),
      join(scratchParent, 'mgr-ffffffff-wt1', 'b.txt'),
    ]);

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(refusal(results, 0)).toContain('作業場の外は写せない');
    expect(refusal(results, 1)).toContain('作業場の外は写せない');
    expect(refusal(results, 2)).toContain('作業場の外は写せない');
    expect(await readdir(dir)).toEqual([]);
  });

  it('写した結果は、今の報告の取り込みでそのまま報告に添えられる', async () => {
    const { outboxRoot, stagedRoot, scratch, dir, attach } = await setup();
    await writeFile(join(scratch, 'report.txt'), 'hello');
    const results = await attach([join(scratch, 'report.txt')]);
    expect(results[0]).toMatchObject({ ok: true, name: 'report.txt' });

    const collected = await collectManagerOutbox({
      root: outboxRoot,
      stagedRoot,
      managerId: MANAGER,
      expectedUid: process.getuid?.(),
      limits: LIMITS,
      maxLargeFileBytes: LIMITS.maxFileBytes,
    });
    expect(collected.rejectedFiles).toEqual([]);
    expect(collected.files).toHaveLength(1);
    expect(collected.files[0]).toMatchObject({ name: 'report.txt', size: 5 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('同じ名前が出し箱に既にあれば、上書きせず別名で写す', async () => {
    const { scratch, dir, attach } = await setup();
    await mkdir(join(scratch, 'x'));
    await mkdir(join(scratch, 'y'));
    await writeFile(join(scratch, 'x', 'README.md'), 'one');
    await writeFile(join(scratch, 'y', 'README.md'), 'two');
    const results = await attach([
      join(scratch, 'x', 'README.md'),
      join(scratch, 'y', 'README.md'),
    ]);
    expect(results.map((r) => (r.ok ? r.name : r.reason))).toEqual(['README.md', 'README-2.md']);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('one');
    expect(await readFile(join(dir, 'README-2.md'), 'utf8')).toBe('two');
  });

  it('出し箱に担い手が置いた symlink と同じ名前でも、その先へは書かない', async () => {
    const { scratch, dir, outside, attach } = await setup();
    await writeFile(join(outside, 'victim'), 'keep');
    await symlink(join(outside, 'victim'), join(dir, 'a.txt'));
    await writeFile(join(scratch, 'a.txt'), 'new');
    const results = await attach([join(scratch, 'a.txt')]);
    expect(results[0]).toMatchObject({ ok: true, name: 'a-2.txt' });
    expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('keep');
  });
});

describe('attachToManagerOutbox: 作業場の外・パスの形', () => {
  it('作業場の外（/etc/hosts・runner の資格の置き場を模した dir）は断り、何も写さない', async () => {
    const { dir, outside, attach } = await setup();
    await mkdir(join(outside, 'credentials'));
    await writeFile(join(outside, 'credentials', 'key'), 'secret');
    const results = await attach(['/etc/hosts', join(outside, 'credentials', 'key')]);
    expect(refusal(results, 0)).toContain('作業場の外は写せない');
    expect(refusal(results, 1)).toContain('作業場の外は写せない');
    expect(await readdir(dir)).toEqual([]);
  });

  it('名前だけ似た dir（mgr-<8桁>x）や、作業場そのもの・相対パスは断る', async () => {
    const { scratchParent, scratch, dir, attach } = await setup();
    await mkdir(join(scratchParent, `${SCRATCH_NAME}x`));
    await writeFile(join(scratchParent, `${SCRATCH_NAME}x`, 'f'), 'f');
    const results = await attach([join(scratchParent, `${SCRATCH_NAME}x`, 'f'), scratch, 'f']);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('`..` を含むパスは、辿れば作業場の下に収まるものでも断る', async () => {
    const { scratch, outside, dir, attach } = await setup();
    await mkdir(join(scratch, 'sub'));
    await writeFile(join(scratch, 'f'), 'f');
    await writeFile(join(outside, 'o'), 'o');
    const results = await attach([
      `${scratch}/sub/../f`,
      `${scratch}/../${outside.split('/').pop()}/o`,
    ]);
    expect(refusal(results, 0)).toContain('`..`');
    expect(refusal(results, 1)).toContain('`..`');
    expect(await readdir(dir)).toEqual([]);
  });

  it('作業場の中の symlink が外を指すとき（ファイル）は断る', async () => {
    const { scratch, outside, dir, attach } = await setup();
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(join(outside, 'secret'), join(scratch, 'link.txt'));
    const results = await attach([join(scratch, 'link.txt')]);
    expect(refusal(results)).toContain('symlink');
    expect(await readdir(dir)).toEqual([]);
  });

  it('親ディレクトリが symlink（外を指す）のときは断る', async () => {
    const { scratch, outside, dir, attach } = await setup();
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(scratch, 'dirlink'));
    const results = await attach([join(scratch, 'dirlink', 'secret')]);
    expect(refusal(results)).toContain('symlink');
    expect(await readdir(dir)).toEqual([]);
  });

  it('作業場そのもの（`mgr-<8桁>-*`）が外を指す symlink のときは断る', async () => {
    const { scratchParent, outside, dir, attach } = await setup();
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(scratchParent, `${SCRATCH_NAME}-evil`));
    const results = await attach([join(scratchParent, `${SCRATCH_NAME}-evil`, 'secret')]);
    expect(refusal(results)).toContain('symlink');
    expect(await readdir(dir)).toEqual([]);
  });

  it('作業場の中の symlink が作業場の別の場所を指すときも、親が symlink なら断る', async () => {
    const { scratch, dir, attach } = await setup();
    await mkdir(join(scratch, 'real'));
    await writeFile(join(scratch, 'real', 'f'), 'f');
    await symlink(join(scratch, 'real'), join(scratch, 'alias'));
    const results = await attach([join(scratch, 'alias', 'f')]);
    expect(refusal(results)).toContain('symlink');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('attachToManagerOutbox: 開いた fd の検め', () => {
  it('持ち主が担い手ではないファイルは断る', async () => {
    const { scratch, dir, attach } = await setup();
    await writeFile(join(scratch, 'f'), 'f');
    const results = await attach([join(scratch, 'f')], {
      expectedUid: (process.getuid?.() ?? 0) + 1,
    });
    expect(refusal(results)).toContain('所有者が担い手ではない');
    expect(await readdir(dir)).toEqual([]);
  });

  it('通常のファイルではないもの（FIFO・ディレクトリ）は断る。FIFO で詰まらない', async () => {
    const { scratch, dir, attach } = await setup();
    execFileSync('mkfifo', [join(scratch, 'pipe')], { env: { PATH: '/usr/bin:/bin' } });
    await mkdir(join(scratch, 'sub'));
    const results = await attach([join(scratch, 'pipe'), join(scratch, 'sub')]);
    expect(refusal(results, 0)).toContain('通常のファイルではない');
    expect(refusal(results, 1)).toContain('ディレクトリ');
    expect(await readdir(dir)).toEqual([]);
  });

  it('ハードリンクのあるファイルは断る', async () => {
    const { scratch, outside, dir, attach } = await setup();
    await writeFile(join(outside, 'orig'), 'x');
    await link(join(outside, 'orig'), join(scratch, 'hard'));
    const results = await attach([join(scratch, 'hard')]);
    expect(refusal(results)).toContain('ハードリンク');
    expect(await readdir(dir)).toEqual([]);
  });

  it('空のファイル・1つの上限を超えるファイルは断る', async () => {
    const { scratch, dir, attach } = await setup();
    await writeFile(join(scratch, 'empty'), '');
    await writeFile(join(scratch, 'big.txt'), Buffer.alloc(LIMITS.maxFileBytes + 1));
    await writeFile(join(scratch, 'big.png'), Buffer.alloc(LIMITS.maxFileBytes + 1));
    const results = await attach([
      join(scratch, 'empty'),
      join(scratch, 'big.txt'),
      join(scratch, 'big.png'),
    ]);
    expect(refusal(results, 0)).toContain('空のファイル');
    expect(refusal(results, 1)).toContain('1つの上限');
    expect(refusal(results, 2)).toContain('1つの上限');
    expect(await readdir(dir)).toEqual([]);
  });

  it('1つの上限を超えても、大きいファイルの上限の内なら（画像以外は）写す', async () => {
    const { scratch, dir, attach } = await setup();
    await writeFile(join(scratch, 'big.zip'), Buffer.alloc(LIMITS.maxFileBytes + 1));
    const results = await attach([join(scratch, 'big.zip')], {
      maxLargeFileBytes: LIMITS.maxFileBytes * 4,
    });
    expect(results[0]).toMatchObject({ ok: true, size: LIMITS.maxFileBytes + 1 });
    expect((await stat(join(dir, 'big.zip'))).size).toBe(LIMITS.maxFileBytes + 1);
  });

  it('個数・合計の上限は、出し箱に既に在るぶんも数える', async () => {
    const { scratch, dir, attach } = await setup();
    const names = ['a', 'b', 'c', 'd'];
    for (const name of names) await writeFile(join(scratch, name), 'x');
    const first = await attach(names.map((n) => join(scratch, n)));
    expect(first.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(refusal(first, 3)).toContain('個数の上限');

    const second = await attach([join(scratch, 'a')]);
    expect(refusal(second)).toContain('個数の上限');
    expect((await readdir(dir)).sort()).toEqual(['a', 'b', 'c']);
  });

  it('合計の上限を超える分だけ断り、残りは写す', async () => {
    const { scratch, attach } = await setup();
    await writeFile(join(scratch, 'one.txt'), Buffer.alloc(1024));
    await writeFile(join(scratch, 'two.txt'), Buffer.alloc(1024));
    await writeFile(join(scratch, 'three.txt'), Buffer.alloc(10));
    const results = await attach([
      join(scratch, 'one.txt'),
      join(scratch, 'two.txt'),
      join(scratch, 'three.txt'),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(refusal(results, 2)).toContain('合計の上限');
  });

  it('無いファイルは理由つきで断り、残りは続ける', async () => {
    const { scratch, attach } = await setup();
    await writeFile(join(scratch, 'ok.txt'), 'ok');
    const results = await attach([join(scratch, 'none.txt'), join(scratch, 'ok.txt')]);
    expect(refusal(results, 0)).toBe('ファイルが無い');
    expect(results[1]).toMatchObject({ ok: true, name: 'ok.txt' });
  });
});
