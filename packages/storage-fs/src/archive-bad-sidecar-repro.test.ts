import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { ArchiveEntry } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsTranscriptArchive.list — 1本の壊れた sidecar で全体を落とさない（issue #1969）', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  async function sidecars(suffix: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        found.push(join(entry.parentPath, entry.name));
      }
    }
    return found.sort();
  }

  async function listQuietly(
    stores: ReturnType<typeof createFsStores>,
  ): Promise<{ entries: ArchiveEntry[]; stderr: string }> {
    let entries: ArchiveEntry[] = [];
    const lines = await captureStderr(async () => {
      entries = await stores.archive.list();
    });
    return { entries, stderr: lines.join('') };
  }

  it('壊れた .meta.json の行は fallbackMeta に倒れて一覧に残り、他の行もそのまま読める', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    const second = await stores.archive.archive('session-b', 'transcript two');
    const metaOfFirst = (await sidecars('.meta.json')).find((path) => path.includes(first.id));
    if (metaOfFirst === undefined) throw new Error('sidecar が見つからない');
    await writeFile(metaOfFirst, '{not json — 秘密の中身');

    const { entries, stderr } = await listQuietly(stores);

    expect(entries.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
    expect(entries.find((entry) => entry.id === second.id)?.sessionId).toBe('session-b');
    expect(entries.find((entry) => entry.id === first.id)?.sessionId).toBe('session-a');
    expect(stderr).toContain(first.id);
    expect(stderr, '壊れた中身そのものは跡に出さない').not.toContain('秘密の中身');
  });

  it('壊れた .removed の行だけが一覧から外れ、他の行はそのまま読める', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    const second = await stores.archive.archive('session-b', 'transcript two');
    await captureStderr(async () => {
      await stores.archive.remove(first.id);
    });
    const markerOfFirst = (await sidecars('.removed')).find((path) => path.includes(first.id));
    if (markerOfFirst === undefined) throw new Error('印が見つからない');
    await writeFile(markerOfFirst, '{"removedAt": 秘密の中身');

    const { entries, stderr } = await listQuietly(stores);

    expect(entries.map((entry) => entry.id)).toEqual([second.id]);
    expect(stderr).toContain(first.id);
    expect(stderr, '壊れた中身そのものは跡に出さない').not.toContain('秘密の中身');
  });

  it('sessions() も、1本の壊れた .meta.json で落ちない', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    await stores.archive.archive('session-b', 'transcript two');
    const metaOfFirst = (await sidecars('.meta.json')).find((path) => path.includes(first.id));
    if (metaOfFirst === undefined) throw new Error('sidecar が見つからない');
    await writeFile(metaOfFirst, '{not json');

    let sessionIds: string[] = [];
    await captureStderr(async () => {
      sessionIds = (await stores.archive.sessions()).map((summary) => summary.sessionId).sort();
    });

    expect(sessionIds).toEqual(['session-a', 'session-b']);
  });

  it('対照: 壊れた sidecar が無ければ、今までどおり全行を読み、跡も出さない', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    const second = await stores.archive.archive('session-b', 'transcript two');

    const { entries, stderr } = await listQuietly(stores);

    expect(entries.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
    expect(stderr).toBe('');
  });
});

describe('FsTranscriptArchive — 壊れた sidecar の跡は1本につき1回（issue #2231）', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  async function sidecarOf(id: string, suffix: string): Promise<string> {
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(suffix) && entry.name.includes(id)) {
        return join(entry.parentPath, entry.name);
      }
    }
    throw new Error(`${suffix} が見つからない`);
  }

  async function stderrOfListing(stores: ReturnType<typeof createFsStores>): Promise<string[]> {
    return captureStderr(async () => {
      await stores.archive.list();
    });
  }

  it('壊れた .meta.json は、list() を3回呼んでも跡は1回だけ', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    await writeFile(await sidecarOf(first.id, '.meta.json'), '{not json');

    const lines = [
      ...(await stderrOfListing(stores)),
      ...(await stderrOfListing(stores)),
      ...(await stderrOfListing(stores)),
    ];

    expect(lines.filter((line) => line.includes('.meta.json'))).toHaveLength(1);
  });

  it('壊れた .removed は、list() を3回呼んでも跡は1回だけ', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    await captureStderr(async () => {
      await stores.archive.remove(first.id);
    });
    await writeFile(await sidecarOf(first.id, '.removed'), '{"removedAt": ');

    const lines = [
      ...(await stderrOfListing(stores)),
      ...(await stderrOfListing(stores)),
      ...(await stderrOfListing(stores)),
    ];

    expect(lines.filter((line) => line.includes('.removed'))).toHaveLength(1);
  });

  it('直してからまた壊すと、もう一度だけ知らせる', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    const meta = await sidecarOf(first.id, '.meta.json');
    const good = await readFile(meta, 'utf8');

    await writeFile(meta, '{not json');
    const broken1 = await stderrOfListing(stores);
    await writeFile(meta, good);
    const repaired = await stderrOfListing(stores);
    await writeFile(meta, '{still not json');
    const broken2 = await stderrOfListing(stores);

    expect(broken1.filter((line) => line.includes('.meta.json'))).toHaveLength(1);
    expect(repaired).toEqual([]);
    expect(broken2.filter((line) => line.includes('.meta.json'))).toHaveLength(1);
  });

  it('壊れた .removed の id を read() で名指しすれば、何度でも投げる（黙らせない）', async () => {
    const stores = createFsStores(root);
    const first = await stores.archive.archive('session-a', 'transcript one');
    await captureStderr(async () => {
      await stores.archive.remove(first.id);
    });
    await writeFile(await sidecarOf(first.id, '.removed'), '{"removedAt": ');
    await stderrOfListing(stores);

    await expect(stores.archive.read(first.id)).rejects.toThrow(/\.removed/);
    await expect(stores.archive.read(first.id)).rejects.toThrow(/\.removed/);
  });
});
