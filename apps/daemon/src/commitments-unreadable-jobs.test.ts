import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, createManagerPool, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Job, ManagerPool, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

const BAD_SUMMARY = '壊れた委譲の本文（この文字列はどの出力にも出てはいけない）';

const COMMITMENT = {
  id: 'cmt-1',
  at: '2026-09-01T00:00:00.000Z',
  origin: 'human' as const,
  source: 'conv-1',
  body: '直してほしい',
};

const GOOD_RUNNING: Job = {
  id: 'mgr-good',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  status: 'running',
  summary: '読める委譲の本文',
  request: '読める委譲の依頼',
  conversationId: 'conv-1',
};

const BAD_JOB_RAW = {
  id: 'mgr-bad',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  status: 'not-a-real-status-from-a-newer-deploy',
  summary: BAD_SUMMARY,
  request: BAD_SUMMARY,
  conversationId: 'conv-1',
};

interface Seeded {
  stores: Stores;
  addBadRow(): Promise<void>;
}

async function seedFs(): Promise<Seeded> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  return {
    stores,
    async addBadRow() {
      const path = join(root, 'jobs', 'jobs.json');
      let raw: { jobs: unknown[]; approvals: unknown[] } = { jobs: [], approvals: [] };
      try {
        raw = JSON.parse(await readFile(path, 'utf8')) as typeof raw;
      } catch {
        // まだファイルが無い。
      }
      raw.jobs.push(BAD_JOB_RAW);
      await mkdir(join(root, 'jobs'), { recursive: true });
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    },
  };
}

async function seedPg(): Promise<Seeded> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  return {
    stores,
    async addBadRow() {
      // 行を直接 insert する: `putJob()` は `jobSchema.parse` を通すため壊れた行を書けない。
      await db.insert(tables.jobs).values({
        id: BAD_JOB_RAW.id,
        status: BAD_JOB_RAW.status,
        createdAt: new Date(BAD_JOB_RAW.createdAt),
        updatedAt: new Date(BAD_JOB_RAW.updatedAt),
        job: BAD_JOB_RAW,
      });
    },
  };
}

function poolOver(stores: Stores): ManagerPool {
  return createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() });
}

function stubCloneHost(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: poolOver(stores),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

async function getCommitments(stores: Stores): Promise<{
  raw: string;
  body: {
    entries: Array<{ id: string; activeManagerIds?: string[] }>;
    unreadableJobs?: Array<{ id?: string; reason: string }>;
  };
}> {
  const app = createApp({
    clone: stubCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request('/commitments', {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { raw, body: JSON.parse(raw) as never };
}

// 雛形の払いは歯の本体（既定 5000ms）でなく hook（明示 30_000ms）にさせる: WASM の起動＋migrate が歯の本体の時間に収まらないため。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  { name: 'fs', seed: seedFs },
  { name: 'pg', seed: seedPg },
])('GET /commitments の読めない委譲（$name）', ({ seed }) => {
  it('読めない委譲の行が1行あると、unreadableJobs に id と欄名だけを載せる', async () => {
    const { stores, addBadRow } = await seed();
    await stores.commitments.open(COMMITMENT);
    await addBadRow();

    let result: Awaited<ReturnType<typeof getCommitments>> | undefined;
    await captureStderr(async () => {
      result = await getCommitments(stores);
    });

    expect(result?.body.unreadableJobs).toEqual([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    expect(result?.raw).not.toContain(BAD_SUMMARY);
  });

  it('読めた委譲から組む activeManagerIds は変えず、読めない行を行へ推測で紐づけない', async () => {
    const { stores, addBadRow } = await seed();
    await stores.commitments.open(COMMITMENT);
    await addBadRow();

    let result: Awaited<ReturnType<typeof getCommitments>> | undefined;
    await captureStderr(async () => {
      result = await getCommitments(stores);
    });

    expect(result?.body.entries.map((entry) => entry.activeManagerIds)).toEqual([undefined]);

    await stores.jobs.putJob(GOOD_RUNNING);
    await captureStderr(async () => {
      result = await getCommitments(stores);
    });
    expect(result?.body.entries[0]?.activeManagerIds).toEqual(['mgr-good']);
    expect(result?.body.unreadableJobs).toHaveLength(1);
  });

  it('対照: 読めない委譲が無ければ、unreadableJobs の鍵は出ない', async () => {
    const { stores } = await seed();
    await stores.commitments.open(COMMITMENT);
    await stores.jobs.putJob(GOOD_RUNNING);

    const { raw, body } = await getCommitments(stores);

    expect('unreadableJobs' in body).toBe(false);
    expect(raw).not.toContain('unreadableJobs');
    expect(body.entries[0]?.activeManagerIds).toEqual(['mgr-good']);
  });

  it('対照: 「委譲あり」を導く対象の行が1件も無ければ、読めない委譲が在っても載せない', async () => {
    const { stores, addBadRow } = await seed();
    await stores.commitments.open({
      id: 'cmt-self',
      at: '2026-09-01T00:00:00.000Z',
      origin: 'self',
      body: '自分で積んだ',
    });
    await addBadRow();

    let result: Awaited<ReturnType<typeof getCommitments>> | undefined;
    await captureStderr(async () => {
      result = await getCommitments(stores);
    });

    expect('unreadableJobs' in (result?.body ?? {})).toBe(false);
  });
});
