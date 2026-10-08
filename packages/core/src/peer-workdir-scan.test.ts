import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { scanPeerWorkdir } from './peer-workdir-scan.js';

const OLD = new Date('2026-10-01T00:00:00.000Z');
const SINCE = Date.parse('2026-10-08T00:00:00.000Z');

async function put(path: string, at: Date = new Date()): Promise<void> {
  await writeFile(path, 'x');
  await utimes(path, at, at);
}

describe('scanPeerWorkdir（#4143）', () => {
  it('開始以降に更新された通常ファイルだけを拾い、.git・node_modules には降りず、symlink は拾わない', async () => {
    const root = await makeTempDir('alteroid-peer-scan-');
    await mkdir(join(root, 'sub', 'deep'), { recursive: true });
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await put(join(root, 'new.png'));
    await put(join(root, 'old.txt'), OLD);
    await put(join(root, 'sub', 'deep', 'made.txt'));
    await put(join(root, '.git', 'index'));
    await put(join(root, 'node_modules', 'pkg', 'index.js'));
    await symlink(join(root, 'new.png'), join(root, 'link.png'));

    const scan = await scanPeerWorkdir(root, SINCE);
    expect([...scan.paths].sort()).toEqual(
      [join(root, 'new.png'), join(root, 'sub', 'deep', 'made.txt')].sort(),
    );
    expect(scan).not.toHaveProperty('truncated');
    expect(scan).not.toHaveProperty('unreadable');
  });

  it('項目の数の上限で打ち切ったら、理由を書く', async () => {
    const root = await makeTempDir('alteroid-peer-scan-');
    for (const name of ['a', 'b', 'c', 'd']) await put(join(root, name));
    const scan = await scanPeerWorkdir(root, SINCE, { maxEntries: 2 });
    expect(scan.paths).toEqual([join(root, 'a'), join(root, 'b')]);
    expect(scan.truncated).toBe('2 項目を見たところで打ち切った');
  });

  it('深さの上限より下へは降りず、降りなかったことを書く', async () => {
    const root = await makeTempDir('alteroid-peer-scan-');
    await mkdir(join(root, 'l1', 'l2'), { recursive: true });
    await put(join(root, 'l1', 'top.txt'));
    await put(join(root, 'l1', 'l2', 'below.txt'));
    const scan = await scanPeerWorkdir(root, SINCE, { maxDepth: 2 });
    expect(scan.paths).toEqual([join(root, 'l1', 'top.txt')]);
    expect(scan.truncated).toBe('深さ 2 段より下は見ていない');
  });

  it('作業場そのものが読めなければ、読めなかった数に数える（投げない）', async () => {
    const root = await makeTempDir('alteroid-peer-scan-');
    const scan = await scanPeerWorkdir(join(root, 'missing'), SINCE);
    expect(scan).toEqual({ paths: [], unreadable: 1 });
  });
});
