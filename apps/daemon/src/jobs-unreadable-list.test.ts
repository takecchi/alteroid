import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildActivityDigest,
  captureStderr,
  createCloneTools,
  createManagerPool,
  createRunnerRegistry,
  describeProgress,
  readProgress,
} from '@alteroid/core';
import type { CloneHost, Job, ManagerPool, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

const BAD_SUMMARY = '壊れた委譲の本文（この文字列はどの出力にも出てはいけない）';

const GOOD: Job = {
  id: 'mgr-good',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  status: 'done',
  summary: '読める委譲の本文',
  request: '読める委譲の依頼',
};

const BAD_JOB_RAW = {
  id: 'mgr-bad',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  status: 'not-a-real-status-from-a-newer-deploy',
  summary: BAD_SUMMARY,
  request: BAD_SUMMARY,
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
        // まだファイルが無い（0件から始めるとき）。
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
      // 行を直接 insert する: `putJob()` は `jobSchema.parse` を通すため。
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

async function getJson(stores: Stores, path: string): Promise<Record<string, unknown>> {
  const app = createApp({
    clone: stubCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function managerListTool(stores: Stores): () => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: poolOver(stores),
  });
  const tool = tools.find((entry) => entry.name === 'manager_list');
  if (!tool) throw new Error('manager_list が無い');
  return async () => {
    const result = await tool.handler({} as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

const since = () => new Date(Date.now() - 60_000);

// 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('委譲の一覧が読めない行を「居ない」と言わない（%s 実装。#2345）', (_label, seed) => {
  it('listUnreadableJobs(): 読めない行は id と不正な欄名だけで返る。listJobs() は読めた行だけ', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let jobs: Job[] = [];
    let unreadable: Awaited<ReturnType<Stores['jobs']['listUnreadableJobs']>> = [];
    await captureStderr(async () => {
      jobs = await stores.jobs.listJobs();
      unreadable = await stores.jobs.listUnreadableJobs();
    });

    expect(jobs.map((job) => job.id)).toEqual(['mgr-good']);
    expect(unreadable).toEqual([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    expect(JSON.stringify(unreadable)).not.toContain(BAD_SUMMARY);
  });

  it('manager_list: 読めた行に加えて「読めない委譲が 1 件ある」と言う', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await managerListTool(stores)();
    });

    expect(reply).toContain('mgr-good');
    expect(reply).toContain('読めない委譲が 1 件ある（id: mgr-bad）');
    expect(reply).toContain('居ないのでも、畳まれたのでもない');
    expect(reply).not.toContain(BAD_SUMMARY);
  });

  it('manager_list: 読めた行が0件でも「マネージャーは1本も居ない」と言わない', async () => {
    const { stores, addBadRow } = await seed();
    await addBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await managerListTool(stores)();
    });

    expect(reply).not.toContain('マネージャーは1本も居ない');
    expect(reply).toContain('（読めたマネージャーは無い。居ないとは言えない）');
    expect(reply).toContain('読めない委譲が 1 件ある（id: mgr-bad）');
  });

  it('digest: 件数の行と節で「読めない委譲」を言う。読めた委譲は今までどおり', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob({ ...GOOD, updatedAt: new Date().toISOString() });
    await addBadRow();

    let digest = '';
    await captureStderr(async () => {
      digest = await buildActivityDigest(stores, { since: since() });
    });

    expect(digest).toContain('- マネージャーへの委譲（この期間に動いたもの）: 1 本');
    expect(digest).toContain('- 読めない委譲（壊れた行。上の本数には入っていない）: 1 件');
    expect(digest).toContain('読めない委譲が 1 件ある（id: mgr-bad）');
    expect(digest).toContain('mgr-good');
    expect(digest).not.toContain(BAD_SUMMARY);
  });

  it('digest: 読めた委譲が0件でも、読めない行の節は出る', async () => {
    const { stores, addBadRow } = await seed();
    await addBadRow();

    let digest = '';
    await captureStderr(async () => {
      digest = await buildActivityDigest(stores, { since: since() });
    });

    expect(digest).toContain('## マネージャー');
    expect(digest).toContain('読めない委譲が 1 件ある（id: mgr-bad）');
  });

  it('GET /managers: unreadable を載せる。読めた行は managers に今までどおり出る', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let body: Record<string, unknown> = {};
    await captureStderr(async () => {
      body = await getJson(stores, '/managers');
    });

    expect((body.managers as { managerId: string }[]).map((entry) => entry.managerId)).toEqual([
      'mgr-good',
    ]);
    expect(body.unreadable).toEqual([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    expect(JSON.stringify(body)).not.toContain(BAD_SUMMARY);
  });

  it('GET /managers: status の絞りでも unreadable は切らない（状態が取れないので）', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let body: Record<string, unknown> = {};
    await captureStderr(async () => {
      body = await getJson(stores, '/managers?status=running');
    });

    expect(body.managers).toEqual([]);
    expect(body.unreadable).toEqual([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
  });

  it('GET /progress と describeProgress: backlog.completeness.unreadableJobs に数える', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let body: { backlog: { completeness: Record<string, number> } } | undefined;
    let text = '';
    await captureStderr(async () => {
      body = (await getJson(stores, '/progress')) as never;
      text = describeProgress(await readProgress(stores, { now: new Date() }));
    });

    expect(body?.backlog.completeness).toEqual({
      unreadable: 0,
      trimmedClosed: 0,
      unreadableJobs: 1,
    });
    expect(text).toContain('※ 読めない委譲の行が 1 件ある');
  });

  it('対照: 本当に0件なら「居ない」と言い、読めない行の文言も鍵も出ない', async () => {
    const { stores } = await seed();

    const reply = await managerListTool(stores)();
    expect(reply).toContain('（マネージャーは1本も居ない）');
    expect(reply).not.toContain('読めない');
    const digest = await buildActivityDigest(stores, { since: since() });
    expect(digest).not.toContain('読めない委譲');
    expect(digest).not.toContain('## マネージャー');
    const body = await getJson(stores, '/managers');
    expect('unreadable' in body).toBe(false);
    const progress = (await getJson(stores, '/progress')) as {
      backlog: { completeness: Record<string, number> };
    };
    expect(progress.backlog.completeness.unreadableJobs).toBe(0);
    expect(describeProgress(await readProgress(stores, { now: new Date() }))).not.toContain(
      '読めない委譲',
    );
  });

  it('対照: 読める行だけなら、読めない行の文言も鍵も出ない', async () => {
    const { stores } = await seed();
    await stores.jobs.putJob({ ...GOOD, updatedAt: new Date().toISOString() });

    expect(await managerListTool(stores)()).not.toContain('読めない');
    const digest = await buildActivityDigest(stores, { since: since() });
    expect(digest).not.toContain('読めない委譲');
    const body = await getJson(stores, '/managers');
    expect('unreadable' in body).toBe(false);
  });
});
