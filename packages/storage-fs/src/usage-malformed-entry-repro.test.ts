import { readFile, writeFile } from 'node:fs/promises';

import { captureStderr } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsUsageStore — usage.json の不正な1エントリを読み飛ばす（issue #1968）', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  async function usagePath(): Promise<string> {
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name === 'usage.json') return join(entry.parentPath, entry.name);
    }
    throw new Error('usage.json が見つからない');
  }

  async function recordOne(
    stores: ReturnType<typeof createFsStores>,
    managerId: string,
  ): Promise<void> {
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      managerId,
      date: '2026-09-28',
      at: '2026-09-28T00:00:00.000Z',
      snapshot: {
        models: {
          opus: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 1,
          },
        },
      },
      accumulation: 'cumulative',
    });
  }

  async function writeCorrupted(): Promise<ReturnType<typeof createFsStores>> {
    const stores = createFsStores(root);
    await recordOne(stores, 'mgr-good');
    const path = await usagePath();
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, unknown>>;
    raw.rows = { ...raw.rows, 'bad-row-key': { nope: '壊れた行の中身（跡に出てはいけない）' } };
    raw.baselines = { ...raw.baselines, 'bad-baseline-key': { nope: 1 } };
    raw.turns = { ...raw.turns, 'bad-turn-key': { nope: 1 } };
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    return stores;
  }

  it('recordedManagerIds() は正しいエントリだけを読み、stderr に鍵だけの跡を残す', async () => {
    const stores = await writeCorrupted();
    let ids: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        ids = [...(await stores.usage.recordedManagerIds())];
      })
    ).join('');
    expect(ids).toEqual(['mgr-good']);
    expect(stderr).toContain('bad-row-key');
    expect(stderr, '壊れたエントリの中身そのものは跡に出さない').not.toContain('壊れた行の中身');
  });

  it('record() も落ちず、壊れたエントリはファイルに生の形のまま残る', async () => {
    const stores = await writeCorrupted();
    await captureStderr(async () => {
      await recordOne(stores, 'mgr-second');
    });
    const raw = JSON.parse(await readFile(await usagePath(), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(raw.rows ?? {})).toContain('bad-row-key');
    expect(Object.keys(raw.baselines ?? {})).toContain('bad-baseline-key');
    expect(Object.keys(raw.turns ?? {})).toContain('bad-turn-key');
    let ids: string[] = [];
    await captureStderr(async () => {
      ids = [...(await stores.usage.recordedManagerIds())].sort();
    });
    expect(ids).toEqual(['mgr-good', 'mgr-second']);
  });

  it('clear() は壊れたエントリも消して件数に数える', async () => {
    const stores = await writeCorrupted();
    let removed: { daily: number; baseline: number; ledger: number; turns: number } | undefined;
    await captureStderr(async () => {
      removed = await stores.usage.clear();
    });
    expect(removed).toMatchObject({ daily: 2, baseline: 2, turns: 2 });
    const raw = JSON.parse(await readFile(await usagePath(), 'utf8')) as Record<string, unknown>;
    expect(raw.rows).toEqual({});
    expect(raw.baselines).toEqual({});
    expect(raw.turns).toEqual({});
  });

  it('対照: 壊れたエントリが無ければ今までどおり読み、跡も出さない', async () => {
    const stores = createFsStores(root);
    await recordOne(stores, 'mgr-good');
    let ids: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        ids = [...(await stores.usage.recordedManagerIds())];
      })
    ).join('');
    expect(ids).toEqual(['mgr-good']);
    expect(stderr).toBe('');
  });
});
