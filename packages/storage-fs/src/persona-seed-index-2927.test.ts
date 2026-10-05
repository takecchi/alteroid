import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256Hex } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores, initWorkspace } from './index.js';

/**
 * issue #2927 項目5。新しい作業場（`initWorkspace` の直後）や `persona.clear()` の後の
 * 最初の `persona.write` / `protectionStatus` で、fs だけが保護状態の索引を「失われた」と
 * 見て組み直し、「索引の組み直し」の decision を日誌へ1件書いていた（pg は新しい DB では
 * 書かない）。`initWorkspace` が seed と一緒に索引も置き、`clear` が空の索引を置く。
 * 索引が本当に失われたときは、従来どおり組み直して decision を1件書く。
 */
describe('fs の索引の初期状態と組み直しの decision（#2927 項目5）', () => {
  let root: string;
  let stores: ReturnType<typeof createFsStores>;
  const indexPath = () => join(root, 'memory', '.index.json');

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  async function rebuildDecisions(): Promise<number> {
    const entries = await stores.journal.list({ types: ['decision'] });
    return entries.filter((e) => 'decision' in e && e.decision.includes('組み直した')).length;
  }

  it('initWorkspace の直後に persona.write と protectionStatus を呼んでも、日誌は空のまま', async () => {
    await initWorkspace(root);

    await stores.persona.write('values', '# 価値観\n\nV1\n');
    expect(await stores.persona.protectionStatus('about-me')).toEqual({ kind: 'clone-only' });
    expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

    expect(await stores.journal.list()).toEqual([]);
  });

  it('initWorkspace が置く索引は、seed の本文のハッシュを持つ（組み直しと同じ形）', async () => {
    await initWorkspace(root);

    const seed = await readFile(join(root, 'memory', 'about-me.md'), 'utf8');
    expect(JSON.parse(await readFile(indexPath(), 'utf8'))).toEqual({
      'about-me': { contentSha256: sha256Hex(seed) },
    });
  });

  it('initWorkspace の二度目は既存の索引を上書きしない', async () => {
    await initWorkspace(root);
    await stores.persona.write('values', '# 価値観\n\nV1\n');
    const before = await readFile(indexPath(), 'utf8');

    await initWorkspace(root);

    expect(await readFile(indexPath(), 'utf8')).toBe(before);
  });

  it('persona.clear() の後の persona.write と protectionStatus でも、日誌は空のまま', async () => {
    await initWorkspace(root);
    await stores.persona.write('values', '# 価値観\n\nV1\n');

    expect(await stores.persona.clear()).toBe(2);

    await stores.persona.write('values', '# 価値観\n\nV2\n');
    expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
    expect(await rebuildDecisions()).toBe(0);
    expect(await stores.journal.list()).toEqual([]);
  });

  it('索引を消したときは、従来どおり組み直して decision が1件入る', async () => {
    await initWorkspace(root);
    await stores.persona.write('values', '# 価値観\n\nV1\n');
    await rm(indexPath(), { force: true });

    await stores.persona.protectionStatus('values');
    await stores.persona.protectionStatus('about-me');

    expect(await rebuildDecisions()).toBe(1);
  });
});
