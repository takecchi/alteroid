import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Commitment } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { TRIMMED_ID_LIMIT } from './commitments.js';
import { CLOSED_HISTORY_LIMIT, createFsStores } from './index.js';

const commitment = (id: string): Commitment => ({
  id,
  at: '2026-08-01T00:00:00.000Z',
  origin: 'human',
  body: `仕事 ${id}`,
});

const closedRow = (id: string, index: number): Commitment => ({
  ...commitment(id),
  closedAt: new Date(Date.UTC(2026, 7, 2, 0, 0, 0) + index * 1000).toISOString(),
  closedReason: '片付けた',
  closedBy: 'clone',
});

const closeAt = (index: number): string =>
  new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + index * 1000).toISOString();

describe('保持上限で刈られた片付き行の id は、open で開き直されない（#4060。fs）', () => {
  let root: string;
  let stores: ReturnType<typeof createFsStores>;
  let path: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
    path = join(root, 'jobs', 'commitments.json');
  });

  const seed = async (file: Record<string, unknown>): Promise<void> => {
    // 初回の open で jobs/ を作ってから、ファイルを差し替える
    await stores.commitments.open(commitment('bootstrap'));
    await stores.commitments.clear();
    await writeFile(path, JSON.stringify(file), 'utf8');
  };

  const seedClosed = (count: number): Commitment[] =>
    Array.from({ length: count }, (_, index) =>
      closedRow(`c-${String(index).padStart(4, '0')}`, index),
    );

  it('Issue の手順どおり: 刈られた id を open し直しても opened: false', async () => {
    await stores.commitments.open(commitment('c0'));
    await stores.commitments.close('c0', closeAt(0), '片付けた', 'clone');
    for (let index = 1; index <= CLOSED_HISTORY_LIMIT; index += 1) {
      const id = `x-${String(index).padStart(4, '0')}`;
      await stores.commitments.open(commitment(id));
      await stores.commitments.close(id, closeAt(index), '片付けた', 'clone');
    }
    expect(await stores.commitments.get('c0')).toBeNull();

    const result = await stores.commitments.open(commitment('c0'));

    expect(result.opened).toBe(false);
    expect(await stores.commitments.get('c0')).toBeNull();
    const list = await stores.commitments.list({ includeClosed: true });
    expect(list.entries.some((entry) => entry.id === 'c0')).toBe(false);
    expect(list.trimmedClosed).toBe(1);
  }, 60_000);

  it('上限ちょうど（500件）では刈られず、501件目で最古の1件だけ刈られて覚えられる', async () => {
    await seed({ commitments: seedClosed(CLOSED_HISTORY_LIMIT) });
    await stores.commitments.open(commitment('boundary'));
    await stores.commitments.close('boundary', closeAt(0), '片付けた', 'clone');
    // 500件の行 + boundary が閉じた = 501件。最古（c-0000）だけが刈られる
    let list = await stores.commitments.list({ includeClosed: true });
    expect(list.trimmedClosed).toBe(1);
    expect(list.entries).toHaveLength(CLOSED_HISTORY_LIMIT);

    expect((await stores.commitments.open(commitment('c-0000'))).opened).toBe(false);
    // 刈られていない行の id は、これまでどおり「既に在った」
    expect((await stores.commitments.open(commitment('c-0001'))).opened).toBe(false);
    // 無関係な新しい id は開ける
    expect((await stores.commitments.open(commitment('fresh'))).opened).toBe(true);
    list = await stores.commitments.list();
    expect(list.entries.map((entry) => entry.id)).toEqual(['fresh']);
  });

  it('上限ちょうどのうちは刈られず、何も覚えない', async () => {
    await seed({ commitments: seedClosed(CLOSED_HISTORY_LIMIT) });
    await stores.commitments.open(commitment('fresh'));

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
      trimmedClosedCount: number;
      trimmedClosedIds?: string[];
    };
    expect(onDisk.trimmedClosedCount).toBe(0);
    expect(onDisk.trimmedClosedIds ?? []).toEqual([]);
  });

  it('覚えた id はデーモンを作り直しても残る', async () => {
    await seed({
      commitments: [],
      trimmedClosedCount: 1,
      trimmedClosedIds: ['gone-1'],
    });

    const restarted = createFsStores(root);
    expect((await restarted.commitments.open(commitment('gone-1'))).opened).toBe(false);
    // 無関係な書き込みで消えない
    expect((await restarted.commitments.open(commitment('other'))).opened).toBe(true);
    expect((await createFsStores(root).commitments.open(commitment('gone-1'))).opened).toBe(false);
  });

  it('旧い形式のファイル（trimmedClosedIds が無い）を読め、以後の刈りから覚える', async () => {
    await seed({ commitments: seedClosed(CLOSED_HISTORY_LIMIT), trimmedClosedCount: 7 });

    expect((await stores.commitments.list()).trimmedClosed).toBe(7);
    // 欄が無い時代に刈られた id は分からない（従来どおり開ける）
    expect((await stores.commitments.open(commitment('old-gone'))).opened).toBe(true);

    await stores.commitments.open(commitment('late'));
    await stores.commitments.close('late', closeAt(0), '片付けた', 'clone');
    // c-0000 が刈られる
    expect((await stores.commitments.list()).trimmedClosed).toBe(8);
    expect((await stores.commitments.open(commitment('c-0000'))).opened).toBe(false);
  });

  it('clear() は覚えた id も捨てる', async () => {
    await seed({ commitments: [], trimmedClosedCount: 1, trimmedClosedIds: ['gone-1'] });

    await stores.commitments.clear();

    expect((await stores.commitments.open(commitment('gone-1'))).opened).toBe(true);
  });

  it(`覚える id は ${TRIMMED_ID_LIMIT} 件まで。超えたら古く刈られた側から忘れる`, async () => {
    const remembered = Array.from({ length: TRIMMED_ID_LIMIT }, (_, index) => `g-${index}`);
    await seed({
      commitments: seedClosed(CLOSED_HISTORY_LIMIT),
      trimmedClosedCount: TRIMMED_ID_LIMIT,
      trimmedClosedIds: remembered,
    });
    await stores.commitments.open(commitment('late'));
    await stores.commitments.close('late', closeAt(0), '片付けた', 'clone');

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { trimmedClosedIds: string[] };
    expect(onDisk.trimmedClosedIds).toHaveLength(TRIMMED_ID_LIMIT);
    expect(onDisk.trimmedClosedIds.at(-1)).toBe('c-0000');
    expect((await stores.commitments.open(commitment('c-0000'))).opened).toBe(false);
    expect((await stores.commitments.open(commitment('g-0'))).opened).toBe(true);
    expect((await stores.commitments.open(commitment('g-1'))).opened).toBe(false);
  });
});
