import { chmod, lstat, mkdir, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { extractPlugin } from './plugin-extract.js';
import { parsePluginInput, type PluginInput } from './plugins.js';

const SHA = 'a'.repeat(40);
const encoder = new TextEncoder();

function plugin() {
  return parsePluginInput({
    name: 'demo',
    source: { kind: 'url', url: 'https://example.com/repo', sha: SHA },
    files: [
      {
        path: '.claude-plugin/plugin.json',
        executable: false,
        content: encoder.encode(JSON.stringify({ name: 'demo' })),
      },
      {
        path: 'skills/one/SKILL.md',
        executable: false,
        content: encoder.encode('---\nname: one\ndescription: dummy-content\n---\n'),
      },
    ],
    installedAt: '2026-10-07T00:00:00.000Z',
    installedBy: 'account-1',
  } as PluginInput);
}

async function makeWritable(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) return;
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await makeWritable(join(dir, name));
}

const roots: string[] = [];
async function newRoot(): Promise<string> {
  const root = await makeTempDir('alteroid-plugin-extract-mode-');
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await makeWritable(root);
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;
const ownUid = process.getuid?.() ?? 0;

describe('plugins ディレクトリのモード', () => {
  it('引数なしでは今までどおり 0o700（クローン層の挙動を変えない）', async () => {
    const root = await newRoot();
    const result = await extractPlugin(root, plugin());
    expect(await mode(join(root, 'plugins'))).toBe(0o700);
    expect(await mode(result.path)).toBe(0o555);
  });

  it('runner 用のモードでは root と plugins/ が 0o755 になり、展開物は読めて書けない形のまま', async () => {
    const parent = await newRoot();
    const root = join(parent, 'alteroid-plugins');
    const result = await extractPlugin(root, plugin(), { dirMode: 0o755, expectedUid: ownUid });
    expect(await mode(root)).toBe(0o755);
    expect(await mode(join(root, 'plugins'))).toBe(0o755);
    expect(await mode(result.path)).toBe(0o555);
    expect(await mode(join(result.path, 'skills/one/SKILL.md'))).toBe(0o444);
  });

  it('既にある 0o700 の置き場も、自分の持ち物なら 0o755 へ直す', async () => {
    const parent = await newRoot();
    const root = join(parent, 'alteroid-plugins');
    await mkdir(join(root, 'plugins'), { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(join(root, 'plugins'), 0o700);
    await extractPlugin(root, plugin(), { dirMode: 0o755, expectedUid: ownUid });
    expect(await mode(root)).toBe(0o755);
    expect(await mode(join(root, 'plugins'))).toBe(0o755);
  });

  it('置き場の所有者が期待と違えば拒む（何も展開しない）', async () => {
    const parent = await newRoot();
    const root = join(parent, 'alteroid-plugins');
    await mkdir(join(root, 'plugins'), { recursive: true });
    await expect(
      extractPlugin(root, plugin(), { dirMode: 0o755, expectedUid: ownUid + 1 }),
    ).rejects.toThrow(/所有者/);
    expect(await readdir(join(root, 'plugins'))).toEqual([]);
  });

  it('root が symlink なら拒む', async () => {
    const parent = await newRoot();
    const real = join(parent, 'real');
    await mkdir(real);
    const root = join(parent, 'alteroid-plugins');
    await symlink(real, root);
    await expect(
      extractPlugin(root, plugin(), { dirMode: 0o755, expectedUid: ownUid }),
    ).rejects.toThrow();
    expect(await readdir(real)).toEqual([]);
  });
});
