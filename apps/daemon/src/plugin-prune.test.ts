import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMemoryStores } from '@alteroid/core';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { PLUGIN_SCOPES_FOR_CLONE, pruneExtractedPluginsOnBoot } from './plugin-prune.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const encoder = new TextEncoder();

function input(name: string, scope: 'all' | 'app' | 'runner', sha: string) {
  return {
    name,
    scope,
    source: { kind: 'url' as const, url: 'https://example.invalid/repo', sha },
    files: [
      {
        path: '.claude-plugin/plugin.json',
        executable: false,
        content: encoder.encode('{"name":"dummy-content"}'),
      },
    ],
    installedAt: '2026-10-07T00:00:00.000Z',
    installedBy: 'account-1',
  };
}

describe('daemon 起動時の展開済み plugin の片づけ', () => {
  it('クローン向けの scope は all と app', () => {
    expect([...PLUGIN_SCOPES_FOR_CLONE]).toEqual(['all', 'app']);
  });

  it('ストアに無い版を消し、あるもの・scope が対象外のものを数えずに残す', async () => {
    const root = await makeTempDir('alteroid-plugin-prune-');
    const stores = createMemoryStores();
    await stores.plugins.put(input('keep', 'all', SHA_A));
    await stores.plugins.put(input('runner-only', 'runner', SHA_A));
    for (const dir of [`keep@${SHA_A}`, `keep@${SHA_B}`, `runner-only@${SHA_A}`]) {
      await mkdir(join(root, 'plugins', dir), { recursive: true });
    }
    const written: string[] = [];

    await pruneExtractedPluginsOnBoot({ root, store: stores.plugins, write: (t) => written.push(t) });

    expect((await readdir(join(root, 'plugins'))).sort()).toEqual([`keep@${SHA_A}`]);
    expect(written).toEqual([]);
  });

  it('list が失敗しても投げず、何も消さず、stderr へ理由を出す', async () => {
    const root = await makeTempDir('alteroid-plugin-prune-fail-');
    const stores = createMemoryStores();
    await mkdir(join(root, 'plugins', `old@${SHA_A}`), { recursive: true });
    const written: string[] = [];
    const store = {
      ...stores.plugins,
      list: async () => {
        throw new Error('dummy-reason');
      },
    };

    await expect(
      pruneExtractedPluginsOnBoot({ root, store, write: (t) => written.push(t) }),
    ).resolves.toBeUndefined();

    expect(await readdir(join(root, 'plugins'))).toEqual([`old@${SHA_A}`]);
    expect(written.join('')).toContain('dummy-reason');
  });
});
