import { describe, expect, it } from 'vitest';

import { buildActivityDigest } from './digest.js';
import { readProgress } from './progress-read.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// digest と進捗は、委譲の台帳を `listJobsWithUnreadable()` の1回で読む（2つの口を続けて呼ぶと、pg では jobs 全行の scan が2回走る）

function countingStores(): { stores: Stores; calls: string[] } {
  const stores = createMemoryStores();
  const calls: string[] = [];
  const base = stores.jobs;
  stores.jobs = {
    ...base,
    listJobs: async () => {
      calls.push('listJobs');
      return base.listJobs();
    },
    listUnreadableJobs: async () => {
      calls.push('listUnreadableJobs');
      return base.listUnreadableJobs();
    },
    listJobsWithUnreadable: async () => {
      calls.push('listJobsWithUnreadable');
      return {
        jobs: await base.listJobs(),
        unreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }],
      };
    },
  };
  return { stores, calls };
}

describe('台帳の読みは listJobsWithUnreadable() の1回', () => {
  it('digest: 既存の2つの口は呼ばず、読めない行の断り書きは出る', async () => {
    const { stores, calls } = countingStores();
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });
    expect(calls).toEqual(['listJobsWithUnreadable']);
    expect(digest).toContain('- 読めない委譲が 1 件ある（id: mgr-bad）');
  });

  it('readProgress: 既存の2つの口は呼ばず、読めない行の件数は出る', async () => {
    const { stores, calls } = countingStores();
    const view = await readProgress(stores, { now: new Date() });
    expect(calls).toEqual(['listJobsWithUnreadable']);
    expect(view.backlog.completeness.unreadableJobs).toBe(1);
  });
});
