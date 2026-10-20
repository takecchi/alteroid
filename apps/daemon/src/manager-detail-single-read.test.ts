import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  UnreadableJobError,
} from '@alteroid/core';
import type { CloneHost, Job, ManagerPool, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// GET /managers/:id が1件のために委譲の台帳を全部読まない（#5089）。応答は一覧の該当1件と同じ

const BAD_SUMMARY = '壊れた委譲の本文（この文字列はどの出力にも出てはいけない）';

function job(id: string, createdAt: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'done',
    summary: `${id} の報告`,
    request: `${id} の依頼`,
    ...extra,
  };
}

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
  const path = join(root, 'jobs', 'jobs.json');
  return {
    stores,
    async addBadRow() {
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

async function seedMemory(): Promise<Seeded> {
  return { stores: createMemoryStores(), addBadRow: async () => undefined };
}

function cloneOver(managers: ManagerPool): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers,
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

/** `listJobs` を呼んだ回数を数える（読む口は素通し） */
function countingListJobs(stores: Stores): { stores: Stores; calls: () => number } {
  let calls = 0;
  const jobs = stores.jobs;
  const counted: Stores = {
    ...stores,
    jobs: new Proxy(jobs, {
      get(target, property, receiver) {
        if (property === 'listJobs') {
          return async () => {
            calls += 1;
            return target.listJobs();
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  return { stores: counted, calls: () => calls };
}

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['memory', seedMemory],
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('JobStore.getJob（%s。#5089）', (label, seed) => {
  it('⭐ 在る id は listJobs() の同じ行と同じ値、無い id は null', async () => {
    const { stores } = await seed();
    await stores.jobs.putJob(job('mgr-1', '2026-09-01T00:00:00.000Z'));
    await stores.jobs.putJob(
      job('mgr-2', '2026-09-03T00:00:00.000Z', { status: 'running', conversationId: 'conv-1' }),
    );

    const listed = (await stores.jobs.listJobs()).find((entry) => entry.id === 'mgr-2');
    expect(await stores.jobs.getJob('mgr-2')).toEqual(listed);
    expect(await stores.jobs.getJob('mgr-none')).toBeNull();
  });

  it('返した値を書き換えても台帳は変わらない', async () => {
    const { stores } = await seed();
    await stores.jobs.putJob(job('mgr-1', '2026-09-01T00:00:00.000Z'));
    const got = await stores.jobs.getJob('mgr-1');
    if (got === null) throw new Error('無い');
    got.summary = '書き換えた';
    expect((await stores.jobs.getJob('mgr-1'))?.summary).toBe('mgr-1 の報告');
  });

  it.skipIf(label === 'memory')(
    '在るが読めない行は null ではなく UnreadableJobError（本文は載せない）',
    async () => {
      const { stores, addBadRow } = await seed();
      await addBadRow();
      const error = await stores.jobs.getJob('mgr-bad').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnreadableJobError);
      expect(String((error as Error).message)).not.toContain(BAD_SUMMARY);
    },
  );
});

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('GET /managers/:id（%s。#5089）', (_label, seed) => {
  async function request(stores: Stores, path: string) {
    const app = createApp({
      clone: cloneOver(
        createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
      ),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('⭐ 一覧の該当1件と同じ形を返し、台帳の全件読み（listJobs）を呼ばない', async () => {
    const { stores: base } = await seed();
    for (let i = 0; i < 20; i += 1) {
      await base.jobs.putJob(
        job(
          `mgr-${String(i).padStart(2, '0')}`,
          `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        ),
      );
    }
    const listed = await request(base, '/managers');
    const expected = (listed.body.managers as { managerId: string }[]).find(
      (entry) => entry.managerId === 'mgr-07',
    );

    const { stores, calls } = countingListJobs(base);
    const detail = await request(stores, '/managers/mgr-07');

    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ manager: expected });
    expect(calls()).toBe(0);
  });

  it('無い id は 404', async () => {
    const { stores } = await seed();
    await stores.jobs.putJob(job('mgr-1', '2026-09-01T00:00:00.000Z'));
    const detail = await request(stores, '/managers/mgr-none');
    expect(detail).toEqual({ status: 404, body: { error: 'not found' } });
  });

  it('読めない行の id は 404 ではなく 409（理由は不正な欄名だけで、本文は載せない）', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(job('mgr-1', '2026-09-01T00:00:00.000Z'));
    await addBadRow();
    let detail: Awaited<ReturnType<typeof request>> | undefined;
    await captureStderr(async () => {
      detail = await request(stores, '/managers/mgr-bad');
    });
    expect(detail?.status).toBe(409);
    expect(String(detail?.body.error)).toContain('不正な欄: status');
    expect(JSON.stringify(detail?.body)).not.toContain(BAD_SUMMARY);
  });
});

describe('get を持たない偽のプールでは一覧から探す（#5089）', () => {
  it('list() から同じ1件を返す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-1', '2026-09-01T00:00:00.000Z'));
    const real = createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() });
    const withoutGet: ManagerPool = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'get') return undefined;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createApp({
      clone: cloneOver(withoutGet),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const response = await app.request('/managers/mgr-1', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { manager: { managerId: string } }).manager.managerId).toBe(
      'mgr-1',
    );
  });
});
