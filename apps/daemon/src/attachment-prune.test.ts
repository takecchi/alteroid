import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createMemoryStores, fetchAttachmentCopy } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import {
  DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES,
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
});
