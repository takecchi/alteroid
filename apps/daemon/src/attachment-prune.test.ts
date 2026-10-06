import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createMemoryStores, fetchAttachmentCopy } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import {
  DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES,
  MAX_ATTACHMENT_PRUNE_INTERVAL_MS,
  readAttachmentPruneConfig,
  startAttachmentPruning,
} from './attachment-prune.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('添付ファイルの定期掃除（#3111）', () => {
  it('周期は既定60分。off 系の綴りで外せ、読めない値は notes へ落として既定へ倒す', () => {
    expect(readAttachmentPruneConfig({})).toEqual({
      everyMinutes: DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES,
      notes: [],
    });
    expect(readAttachmentPruneConfig({ ALTEROID_ATTACHMENT_PRUNE_EVERY: '15' }).everyMinutes).toBe(
      15,
    );
    for (const off of ['off', 'none', 'false', '0', 'OFF']) {
      expect(
        readAttachmentPruneConfig({ ALTEROID_ATTACHMENT_PRUNE_EVERY: off }).everyMinutes,
      ).toBeNull();
    }
    const bad = readAttachmentPruneConfig({ ALTEROID_ATTACHMENT_PRUNE_EVERY: 'soon' });
    expect(bad.everyMinutes).toBe(60);
    expect(bad.notes).toHaveLength(1);
  });

  it('1周で期限切れ・未結び付けを消し、結び付いた期限内のものは残す', async () => {
    const stores = createMemoryStores();
    const stale = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
    });
    const kept = await stores.attachments.put({
      name: 'b.png',
      mediaType: 'image/png',
      bytes: PNG,
      conversationId: 'c1',
    });
    const pruner = startAttachmentPruning({
      stores,
      everyMinutes: 60,
      now: () => new Date(Date.now() + 2 * 3_600_000),
    });
    try {
      expect(await pruner.refresh()).toBe(1);
      expect(await stores.attachments.getMeta(stale.id)).toBeUndefined();
      expect(await stores.attachments.getMeta(kept.id)).toBeDefined();
    } finally {
      pruner.stop();
    }
  });

  it('1周で attachment_fetch の写しも掃く（24時間より古いものは消え、新しいものは残る）', async () => {
    const stores = createMemoryStores();
    const copiesDir = await makeTempDir('alteroid-prune-copies-');
    const meta = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
      conversationId: 'c1',
    });
    await fetchAttachmentCopy(stores, copiesDir, meta.id);
    const pruner = startAttachmentPruning({ stores, everyMinutes: 60, copiesDir });
    try {
      await pruner.refresh();
      await expect(stat(join(copiesDir, meta.id))).resolves.toBeTruthy();
      const later = startAttachmentPruning({
        stores,
        everyMinutes: 60,
        copiesDir,
        now: () => new Date(Date.now() + 25 * 3_600_000),
      });
      try {
        await later.refresh();
        await expect(stat(join(copiesDir, meta.id))).rejects.toThrow();
      } finally {
        later.stop();
      }
    } finally {
      pruner.stop();
    }
  });

  it('off なら何もしない（refresh は null、タイマーも無い）', async () => {
    const stores = createMemoryStores();
    const pruner = startAttachmentPruning({ stores, everyMinutes: null });
    expect(await pruner.refresh()).toBeNull();
    pruner.stop();
  });

  it('掃除が投げても落ちず、null を返して次の周へ進める', async () => {
    const stores = createMemoryStores();
    stores.attachments.prune = async () => {
      throw new Error('boom');
    };
    const pruner = startAttachmentPruning({ stores, everyMinutes: 60 });
    try {
      expect(await pruner.refresh()).toBeNull();
    } finally {
      pruner.stop();
    }
  });

  it('添付本体の prune が失敗していても、写しの掃除は走る（#3329）', async () => {
    const stores = createMemoryStores();
    const copiesDir = await makeTempDir('alteroid-prune-copies-fail-');
    const meta = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
      conversationId: 'c1',
    });
    await fetchAttachmentCopy(stores, copiesDir, meta.id);
    stores.attachments.prune = async () => {
      throw new Error('boom');
    };
    const pruner = startAttachmentPruning({
      stores,
      everyMinutes: 60,
      copiesDir,
      now: () => new Date(Date.now() + 25 * 3_600_000),
    });
    try {
      expect(await pruner.refresh()).toBeNull();
      await expect(stat(join(copiesDir, meta.id))).rejects.toThrow();
    } finally {
      pruner.stop();
    }
  });
});

/**
 * `ALTEROID_ATTACHMENT_PRUNE_EVERY` に大きな分数を置くと、`setTimeout` が 2^31-1 ms を超える遅延を
 * 1ms に倒し、掃除が休みなく回る（#3539。#3534 / #3535 の archive-folder と同じ穴）。
 * 実時間は待たない: `setTimeout` を差し替え、渡された遅延だけを記録する。
 */
describe('添付の掃除の周期は setTimeout の範囲に収まる（#3539）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const collectDelays = async (options: {
    everyMinutes: number;
    intervalMs?: number;
  }): Promise<number[]> => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: unknown, delay?: number) => {
      delays.push(delay ?? 0);
      return {
        unref() {},
        ref() {},
        hasRef: () => false,
        refresh() {},
        [Symbol.toPrimitive]: () => 0,
      };
    }) as unknown as typeof setTimeout);
    const pruner = startAttachmentPruning({ stores: createMemoryStores(), ...options });
    // 起動直後の1回が終わると、次の回のタイマーが仕込まれる。
    await pruner.refresh();
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    pruner.stop();
    return delays;
  };

  it('40000 分（約27.8日）でも、仕込む遅延は 2^31-1 ms 以下', async () => {
    const config = readAttachmentPruneConfig({ ALTEROID_ATTACHMENT_PRUNE_EVERY: '40000' });
    expect(config.everyMinutes).toBe(40000);
    const delays = await collectDelays({ everyMinutes: 40000 });
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_147_483_647);
  });

  it('既定の60分は頭打ちに掛からず、そのまま 3_600_000 ms', async () => {
    const delays = await collectDelays({ everyMinutes: DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES });
    expect(delays).toEqual([3_600_000]);
    expect(MAX_ATTACHMENT_PRUNE_INTERVAL_MS).toBe(2_147_483_647);
  });
});
