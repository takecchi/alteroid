import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { ArchiveEntry } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1969。`FsTranscriptArchive.list()` は全行の sidecar（`<id>.meta.json`）と
 * 削除の印（`<id>.removed`）を `Promise.all` で束ねて読むので、以前は1本の sidecar か
 * 印が JSON として壊れているだけで、無関係な全行の一覧が丸ごと例外になっていた
 * （`sessions()` も `list()` を読むので同じく落ちる）。sidecar が「無い」ときは
 * `fallbackMeta(id)` に倒す作りが既に在り、「壊れている」ときだけが例外だった。
 *
 * ここでは、壊れた sidecar は `fallbackMeta` に倒れてその行は一覧に残ること、
 * 壊れた印はその1本だけが一覧から外れること、どちらも stderr に跡を残し、
 * 中身そのものは出さないことを固定する。
 */
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
    // 壊れた行は id から sessionId を取る（`fallbackMeta`）
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
