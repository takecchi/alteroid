import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyPluginStoreContract } from '@alteroid/core';
import type { PluginInput } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * plugin の置き場（#3815 土台1）。契約は3実装で同じ関数を通す
 * （`packages/core/src/plugin-store-contract.ts`）。ここで足すのは fs だけが持つ形
 * —— 0600 / 0700 と、手で書き換えられたファイルの読み方。
 */
let root: string;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  root = await makeTempDir('alteroid-test-');
  stores = createFsStores(root);
});

const SHA = 'c'.repeat(40);

const input = (name = 'my-plugin'): PluginInput => ({
  name,
  source: { kind: 'url', url: 'https://example.invalid/repo', sha: SHA },
  files: [
    { path: '.claude-plugin/plugin.json', executable: false, content: new Uint8Array([123, 125]) },
    { path: 'run.sh', executable: true, content: new Uint8Array([0, 255]) },
  ],
  installedAt: '2026-10-07T00:00:00.000Z',
  installedBy: 'account-1',
});

describe('FsPluginStore', () => {
  it('器の契約（3実装で同じことを測る）', async () => {
    await verifyPluginStoreContract(stores.plugins);
  });

  it('plugins/ は 0700、中のファイルは 0600', async () => {
    await stores.plugins.put(input());
    const dir = join(root, 'plugins');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const entries = await readdir(dir);
    expect(entries).toEqual(['my-plugin.json']);
    expect((await stat(join(dir, 'my-plugin.json'))).mode & 0o777).toBe(0o600);
  });

  it('置き換えのあと一時ファイルが残らない', async () => {
    await stores.plugins.put(input());
    await stores.plugins.put(input());
    expect(await readdir(join(root, 'plugins'))).toEqual(['my-plugin.json']);
  });

  it('files の path をファイルシステムの path にしない（1 plugin = 1 ファイル）', async () => {
    await stores.plugins.put(input());
    const raw = await readFile(join(root, 'plugins', 'my-plugin.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ name: 'my-plugin' });
    // 展開用のディレクトリは作らない（展開は後の PR）
    expect(await readdir(root)).not.toContain('my-plugin');
  });

  it('手で中身を書き換えたファイルは、contentSha256 と合わなければ読むときに投げ、文言に値を載せない', async () => {
    await stores.plugins.put(input());
    const path = join(root, 'plugins', 'my-plugin.json');
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      files: { content: string }[];
    };
    parsed.files[0]!.content = Buffer.from('SECRET-VALUE-1').toString('base64');
    await writeFile(path, JSON.stringify(parsed));
    await expect(stores.plugins.get('my-plugin')).rejects.toThrow(/my-plugin|contentSha256/);
    await expect(stores.plugins.get('my-plugin')).rejects.not.toThrow(/SECRET-VALUE-1/);
  });

  it('手で壊したファイルは投げ、文言に値を載せない。remove では外せる', async () => {
    await stores.plugins.put(input());
    const path = join(root, 'plugins', 'my-plugin.json');
    await writeFile(path, '{"name": "my-plugin", "files": [SECRET-VALUE-2');
    await expect(stores.plugins.get('my-plugin')).rejects.toThrow(/JSON として読めない/);
    await expect(stores.plugins.get('my-plugin')).rejects.not.toThrow(/SECRET-VALUE-2/);
    await expect(stores.plugins.list()).rejects.toThrow(/JSON として読めない/);
    expect(await stores.plugins.remove('my-plugin')).toBe(true);
    expect(await stores.plugins.list()).toEqual([]);
  });

  it('ファイル名と中の name が食い違うものは読まない（他の名前になりすませない）', async () => {
    await stores.plugins.put(input('first'));
    const dir = join(root, 'plugins');
    await writeFile(join(dir, 'second.json'), await readFile(join(dir, 'first.json')));
    await expect(stores.plugins.get('second')).rejects.toThrow(/second/);
  });

  it('plugins/ に無関係なファイルがあっても list は .json だけを見る', async () => {
    await stores.plugins.put(input());
    await writeFile(join(root, 'plugins', 'README.txt'), 'x');
    expect((await stores.plugins.list()).map((p) => p.name)).toEqual(['my-plugin']);
  });
});
