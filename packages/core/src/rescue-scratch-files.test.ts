import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  listScratchFiles,
  SCRATCH_DEPTH_LIMIT,
  SCRATCH_FILES_LIMIT,
  type ScratchDirEntry,
  type ScratchReaddirFn,
} from './rescue-scratch-files.js';

type Node = 'file' | 'symlink' | { [name: string]: Node };

/** 実ファイルを大量に作らずに、上限を再現する木。 */
function fakeReaddir(tree: { [name: string]: Node }): ScratchReaddirFn {
  return async (dir) => {
    const parts = dir.split('/').filter((p) => p !== '' && p !== 'root');
    let node: Node = tree;
    for (const part of parts) {
      if (typeof node !== 'object') throw new Error('ENOTDIR');
      const next: Node | undefined = node[part];
      if (next === undefined) throw new Error('ENOENT');
      node = next;
    }
    if (typeof node !== 'object') throw new Error('ENOTDIR');
    return Object.entries(node).map(([name, child]): ScratchDirEntry => ({
      name,
      isDirectory: () => typeof child === 'object',
      isFile: () => child === 'file',
      isSymbolicLink: () => child === 'symlink',
    }));
  };
}

const list = (
  tree: { [name: string]: Node },
  options: { maxFiles?: number; maxDepth?: number } = {},
) => listScratchFiles('/root', { readdirFn: fakeReaddir(tree), ...options });

describe('担当の作業場の git でない置き場の列挙（#5255）', () => {
  it('ファイルを置き場からの相対の名前で、並びを固定して返す', async () => {
    const listing = await list({ 'b.sh': 'file', tools: { 'a.mjs': 'file' }, 'a.md': 'file' });
    expect(listing.names).toEqual(['a.md', 'b.sh', path.join('tools', 'a.mjs')]);
    expect(listing.skipped).toEqual([]);
    expect(listing.isWorktree).toBe(false);
  });

  it('除外名（依存と生成物の置き場）の中へは降りず、同じ名前のファイルも数えない', async () => {
    const tree: { [name: string]: Node } = { keep: 'file' };
    for (const name of [
      'node_modules',
      '.pnpm-store',
      '.cache',
      '.venv',
      '__pycache__',
      'target',
      '.next',
      '.turbo',
    ]) {
      tree[name] = { inner: 'file' };
    }
    tree.sub = { target: 'file', ok: 'file' };
    const listing = await list(tree);
    expect(listing.names).toEqual(['keep', path.join('sub', 'ok')]);
    expect(listing.skipped).toEqual([]);
  });

  it('symlink は辿らず、名前にも入れない', async () => {
    const listing = await list({ link: 'symlink', dirlink: 'symlink', real: 'file' });
    expect(listing.names).toEqual(['real']);
  });

  it('git の作業ツリーの根（.git を持つディレクトリ）の下へは降りない。そこは作業ツリーの経路が拾う', async () => {
    const listing = await list({
      script: 'file',
      repo: { '.git': {}, 'inside.txt': 'file', deep: { 'x.txt': 'file' } },
      linked: { '.git': 'file', 'inside.txt': 'file' },
    });
    expect(listing.names).toEqual(['script']);
  });

  it('置き場の根が作業ツリーそのものなら何も列挙せず、そう伝える（二重に預けない）', async () => {
    const listing = await list({ '.git': {}, 'a.txt': 'file', sub: { 'b.txt': 'file' } });
    expect(listing).toEqual({ names: [], skipped: [], isWorktree: true });
  });

  it('件数の上限を超えたら列挙を打ち切り、打ち切ったと理由つきで知らせる', async () => {
    const files: { [name: string]: Node } = {};
    for (let i = 0; i < 5; i += 1) files[`f${String(i)}`] = 'file';
    const listing = await list(files, { maxFiles: 3 });
    expect(listing.names).toEqual(['f0', 'f1', 'f2']);
    expect(listing.skipped).toHaveLength(1);
    expect(listing.skipped[0]?.path).toBe('(省略)');
    expect(listing.skipped[0]?.reason).toContain('cycle-budget');
    expect(listing.skipped[0]?.reason).toContain('3 件');
  });

  it('ちょうど上限の件数なら打ち切らない', async () => {
    const listing = await list({ a: 'file', b: 'file' }, { maxFiles: 2 });
    expect(listing.names).toEqual(['a', 'b']);
    expect(listing.skipped).toEqual([]);
  });

  it('深さの上限より深いディレクトリの中は列挙せず、数を理由つきで知らせる', async () => {
    const deep: { [name: string]: Node } = { 'bottom.txt': 'file' };
    const tree: { [name: string]: Node } = {
      'top.txt': 'file',
      d1: { 'one.txt': 'file', d2: deep },
    };
    const listing = await list(tree, { maxDepth: 1 });
    expect(listing.names).toEqual(['top.txt', path.join('d1', 'one.txt')]);
    expect(listing.skipped).toHaveLength(1);
    expect(listing.skipped[0]?.reason).toContain('cycle-budget');
    expect(listing.skipped[0]?.reason).toContain('深さの上限 1');
    expect(listing.skipped[0]?.reason).toContain('1 件');
  });

  it('既定の上限は 2000 件・深さ 12', () => {
    expect(SCRATCH_FILES_LIMIT).toBe(2000);
    expect(SCRATCH_DEPTH_LIMIT).toBe(12);
  });

  it('深さ 12 のディレクトリまでは列挙する（既定）', async () => {
    let node: { [name: string]: Node } = { 'leaf.txt': 'file' };
    const expected: string[] = [];
    for (let i = 0; i < SCRATCH_DEPTH_LIMIT; i += 1) node = { d: node };
    const listing = await list(node);
    expected.push(path.join(...Array.from({ length: SCRATCH_DEPTH_LIMIT }, () => 'd'), 'leaf.txt'));
    expect(listing.names).toEqual(expected);
    const tooDeep = await list({ d: node });
    expect(tooDeep.names).toEqual([]);
    expect(tooDeep.skipped).toHaveLength(1);
  });

  it('実ファイルでも symlink と除外名を外す', async () => {
    const root = await makeTempDir('scratch-files-test-');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'x.js'), 'x');
    await mkdir(path.join(root, 'bench'), { recursive: true });
    await writeFile(path.join(root, 'bench', 'run.sh'), 'echo');
    await symlink(path.join(root, 'bench', 'run.sh'), path.join(root, 'alias.sh'));
    const listing = await listScratchFiles(root);
    expect(listing.names).toEqual([path.join('bench', 'run.sh')]);
  });

  it('読めないディレクトリは飛ばし、他を止めない', async () => {
    const listing = await listScratchFiles('/nonexistent-scratch-root-for-test');
    expect(listing).toEqual({ names: [], skipped: [], isWorktree: false });
  });
});
