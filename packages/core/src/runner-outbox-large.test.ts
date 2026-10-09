import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { collectManagerOutbox, prepareManagerOutbox } from './runner-outbox.js';

// #4128 段3b: 大きいファイル（画像以外で maxFileBytes を超えるもの）は、別の上限・別の合計の予算で受ける
const MANAGER = 'mgr-large1';
const LIMITS = { maxFileBytes: 1024, maxPerMessage: 5, maxTotalBytes: 2048 };
const MAX_LARGE = 10_000;

async function setup(overrides: Partial<Parameters<typeof collectManagerOutbox>[0]> = {}) {
  const root = await makeTempDir('runner-outbox-large-');
  const stagedRoot = await makeTempDir('runner-outbox-large-staged-');
  const dir = prepareManagerOutbox({ root, managerId: MANAGER });
  const collect = (more: Partial<Parameters<typeof collectManagerOutbox>[0]> = {}) =>
    collectManagerOutbox({
      root,
      stagedRoot,
      managerId: MANAGER,
      expectedUid: process.getuid?.(),
      limits: LIMITS,
      maxLargeFileBytes: MAX_LARGE,
      ...overrides,
      ...more,
    });
  return { dir, stagedRoot, collect };
}

describe('collectManagerOutbox の大きいファイル（#4128 段3b）', () => {
  it('(a) maxFileBytes を超え、上限以下の画像以外は取り込む。上限を超えるものは断り、名前を消す', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(5000, 1));
    await writeFile(join(dir, 'huge.bin'), Buffer.alloc(MAX_LARGE + 1));
    const result = await collect();
    expect(result.files.map((f) => [f.name, f.size])).toEqual([['big.bin', 5000]]);
    expect(result.rejectedFiles).toEqual([
      { name: 'huge.bin', reason: expect.stringContaining(`1つの上限（${MAX_LARGE} バイト）`) },
    ]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('(a) 画像（拡張子で見る）は大きいファイルにせず、maxFileBytes を超えれば断る', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'pic.png'), Buffer.alloc(LIMITS.maxFileBytes + 1));
    const result = await collect();
    expect(result.files).toEqual([]);
    expect(result.rejectedFiles[0]?.reason).toContain(`1つの上限（${LIMITS.maxFileBytes} バイト）`);
  });

  it('(b) 大きいファイルは maxTotalBytes の合計に数えない（小さいものの合計だけが上限以内なら通る）', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'a.bin'), Buffer.alloc(1024));
    await writeFile(join(dir, 'b.bin'), Buffer.alloc(1024));
    await writeFile(join(dir, 'c.big'), Buffer.alloc(5000));
    const result = await collect();
    expect(result.rejectedFiles).toEqual([]);
    expect(result.files.map((f) => f.name)).toEqual(['a.bin', 'b.bin', 'c.big']);
  });

  it('(c) 大きいファイルの合計が別予算ちょうどなら通り、超える分は名前を残して次の報告へ回る', async () => {
    const { dir, collect } = await setup();
    await writeFile(join(dir, 'l1.bin'), Buffer.alloc(5000));
    await writeFile(join(dir, 'l2.bin'), Buffer.alloc(5000));
    await writeFile(join(dir, 'l3.bin'), Buffer.alloc(2000));
    const first = await collect();
    expect(first.files.map((f) => f.name)).toEqual(['l1.bin', 'l2.bin']);
    expect(first.rejectedFiles).toEqual([
      { name: 'l3.bin', reason: expect.stringContaining('大きいファイルの合計の上限') },
    ]);
    expect(first.rejectedFiles[0]?.reason).toContain('次の報告で送る');
    expect(await readdir(dir)).toEqual(['l3.bin']);
    // 次の報告で送れる
    expect((await collect()).files.map((f) => f.name)).toEqual(['l3.bin']);
  });

  it('(c) 大きいファイルも個数（maxPerMessage）に数える', async () => {
    const { dir, collect } = await setup({ limits: { ...LIMITS, maxPerMessage: 1 } });
    await writeFile(join(dir, 'l1.bin'), Buffer.alloc(2000));
    await writeFile(join(dir, 'l2.bin'), Buffer.alloc(2000));
    const result = await collect();
    expect(result.files.map((f) => f.name)).toEqual(['l1.bin']);
    expect(result.rejectedFiles).toEqual([
      { name: 'l2.bin', reason: expect.stringContaining('個数') },
    ]);
    expect(await readdir(dir)).toEqual(['l2.bin']);
  });

  it('(c) 退避先の大きいファイルの予算（上限 × 2）は、小さいものの予算とは別に見る', async () => {
    const { dir, collect } = await setup({
      limits: { ...LIMITS, maxFileBytes: 100, maxTotalBytes: 100 },
      maxLargeFileBytes: 1000,
    });
    // 退避先は消さない（デーモンが取りに来ない）ので、報告のたびに溜まる: 1000 × 2 で満杯
    for (let i = 0; i < 2; i += 1) {
      await writeFile(join(dir, `l${i}.bin`), Buffer.alloc(1000));
      expect((await collect()).files).toHaveLength(1);
    }
    await writeFile(join(dir, 'over.bin'), Buffer.alloc(1000));
    await writeFile(join(dir, 'small.txt'), Buffer.alloc(50));
    const result = await collect();
    expect(result.files.map((f) => f.name)).toEqual(['small.txt']);
    expect(result.rejectedFiles).toEqual([
      { name: 'over.bin', reason: expect.stringContaining('大きいファイルの合計の上限') },
    ]);
    expect(await readdir(dir)).toEqual(['over.bin']);
  });
});
