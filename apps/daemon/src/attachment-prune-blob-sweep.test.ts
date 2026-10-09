import { createMemoryStores, type AttachmentBlobSweepResult } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ATTACHMENT_BLOB_SWEEP_EVERY_MS, startAttachmentPruning } from './attachment-prune.js';

const HOUR = 3_600_000;

function fixture(result: AttachmentBlobSweepResult | undefined = undefined) {
  const stores = createMemoryStores();
  const calls: Date[] = [];
  stores.attachments.sweepOrphanBlobs = async (now: Date) => {
    calls.push(now);
    return result;
  };
  let clock = new Date('2026-03-10T00:00:00Z').getTime();
  return {
    stores,
    calls,
    now: () => new Date(clock),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('控えの無い blob の掃除の周期（#4314）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('起動直後の1回目は呼び、24時間経つまでは呼ばない。経てば呼ぶ（時刻は注入）', async () => {
    const f = fixture();
    const pruner = startAttachmentPruning({
      stores: f.stores,
      everyMinutes: 60,
      now: f.now,
      intervalMs: 2_147_483_647,
    });
    try {
      await pruner.refresh();
      expect(f.calls).toHaveLength(1);
      f.advance(ATTACHMENT_BLOB_SWEEP_EVERY_MS - 1);
      await pruner.refresh();
      expect(f.calls).toHaveLength(1);
      f.advance(1);
      await pruner.refresh();
      expect(f.calls).toHaveLength(2);
      f.advance(HOUR);
      await pruner.refresh();
      expect(f.calls).toHaveLength(2);
    } finally {
      pruner.stop();
    }
  });

  it('止めている（off）なら呼ばない', async () => {
    const f = fixture();
    const pruner = startAttachmentPruning({ stores: f.stores, everyMinutes: null, now: f.now });
    await pruner.refresh();
    pruner.stop();
    expect(f.calls).toHaveLength(0);
  });

  it('sweepOrphanBlobs が無い store（memory・fs）では何もせず落ちない', async () => {
    const stores = createMemoryStores();
    expect(stores.attachments.sweepOrphanBlobs).toBeUndefined();
    const pruner = startAttachmentPruning({ stores, everyMinutes: 60 });
    try {
      await expect(pruner.refresh()).resolves.toBe(0);
    } finally {
      pruner.stop();
    }
  });

  it('未設定（undefined）なら stderr に何も出さない', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const f = fixture(undefined);
    const pruner = startAttachmentPruning({ stores: f.stores, everyMinutes: 60, now: f.now });
    try {
      await pruner.refresh();
      expect(f.calls).toHaveLength(1);
      expect(write).not.toHaveBeenCalled();
    } finally {
      pruner.stop();
    }
  });

  it('何も消さず失敗も無ければ stderr に何も出さない。消したら件数を1行、失敗があれば理由も', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const quiet = fixture({ listed: 3, candidates: 0, removed: 0, failed: 0 });
    const p1 = startAttachmentPruning({ stores: quiet.stores, everyMinutes: 60, now: quiet.now });
    await p1.refresh();
    p1.stop();
    expect(write).not.toHaveBeenCalled();

    const done = fixture({ listed: 5, candidates: 2, removed: 2, failed: 0 });
    const p2 = startAttachmentPruning({ stores: done.stores, everyMinutes: 60, now: done.now });
    await p2.refresh();
    p2.stop();
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('2 件を消した');

    write.mockClear();
    const bad = fixture({ listed: 5, candidates: 2, removed: 0, failed: 2, reason: '断られた' });
    const p3 = startAttachmentPruning({ stores: bad.stores, everyMinutes: 60, now: bad.now });
    await p3.refresh();
    p3.stop();
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toContain('2 件は消せなかった');
    expect(line).toContain('断られた');
  });

  it('列挙が投げても落ちず、行の prune の結果は返る。行の prune が落ちていても呼ぶ', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const f = fixture();
    f.stores.attachments.sweepOrphanBlobs = async () => {
      throw new Error('列挙が落ちた');
    };
    const pruner = startAttachmentPruning({ stores: f.stores, everyMinutes: 60, now: f.now });
    try {
      await expect(pruner.refresh()).resolves.toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('列挙が落ちた');
    } finally {
      pruner.stop();
    }

    const g = fixture();
    g.stores.attachments.prune = async () => {
      throw new Error('boom');
    };
    const p2 = startAttachmentPruning({ stores: g.stores, everyMinutes: 60, now: g.now });
    try {
      await expect(p2.refresh()).resolves.toBeNull();
      expect(g.calls).toHaveLength(1);
    } finally {
      p2.stop();
    }
  });
});
