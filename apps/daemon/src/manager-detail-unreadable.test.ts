import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createCloneTools,
  createManagerPool,
  createRunnerRegistry,
  describeUnreadableManagerRow,
} from '@alteroid/core';
import type { CloneHost, Job, ManagerPool, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * issue #2359 の1。`GET /managers/:id` と道具 `manager_report` は、委譲の行が在るのに壊れて
 * 読めない id を「居ない」（404 `not found` / 「マネージャー X は居ない」）と言っていた。
 * 読めない行として在る id なら「読めない形で入っている」と言い分ける（`GET /practices/:slug` の
 * 409 と同じ線。#2011）。本文は載せず、理由は不正な欄名だけ。
 *
 * fs / pg の2実装で、**実物のストアに不正な行を1行だけ置いた状態から**測る。
 * 対照: 本当に無い id は今までどおり 404 と「居ない」。読める id は 200。
 */

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

async function getManager(
  stores: Stores,
  id: string,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const app = createApp({
    clone: stubCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request(`/managers/${id}`, {
    headers: { authorization: 'Bearer test-token' },
  });
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

function managerReportTool(stores: Stores): (managerId: string) => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: poolOver(stores),
  });
  const tool = tools.find((entry) => entry.name === 'manager_report');
  if (!tool) throw new Error('manager_report が無い');
  return async (managerId) => {
    const result = await tool.handler({ managerId } as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

// PGlite の雛形（WASM の起動＋migrate）は、ワーカーで最初に呼んだ歯が払う。
// 歯の本体（既定 5000ms）でなく hook（明示 30_000ms）で払わせる（issue #2378、#2360 / #2364 と同じ形）。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('委譲の単票が読めない行を居ないと言わない（%s。#2359）', (_label, seed) => {
  it('GET /managers/:id: 読めない行の id は 409。理由は不正な欄名で、本文は含まない', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let result: Awaited<ReturnType<typeof getManager>> | undefined;
    await captureStderr(async () => {
      result = await getManager(stores, 'mgr-bad');
    });

    expect(result?.status).toBe(409);
    const error = String(result?.body.error);
    expect(error).toContain('読めない形で入っている');
    expect(error).toContain('不正な欄: status');
    expect(error).not.toContain('居ない');
    // 文は共通の関数（`describeUnreadableManagerRow`）の1文そのものである（直書きにしない。#2359）。
    expect(error).toBe(describeUnreadableManagerRow('mgr-bad', '不正な欄: status'));
    expect(result?.raw).not.toContain(BAD_SUMMARY);
  });

  it('manager_report: 読めない行の id を「居ない」と言わず、読めない形で在ると言う', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await managerReportTool(stores)('mgr-bad');
    });

    expect(reply).not.toContain('居ない');
    expect(reply).toContain('マネージャー mgr-bad は読めない形で入っている');
    expect(reply).toContain('不正な欄: status');
    expect(reply).not.toContain(BAD_SUMMARY);
    // HTTP の口（409）と同じ、共通の関数の1文である（#2359）。
    expect(reply).toBe(describeUnreadableManagerRow('mgr-bad', '不正な欄: status'));
  });

  it('対照: 本当に無い id は、今までどおり 404 と「居ない」（読めない行が別に在っても）', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    await captureStderr(async () => {
      const result = await getManager(stores, 'mgr-nothing');
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'not found' });
      const reply = await managerReportTool(stores)('mgr-nothing');
      expect(reply).toContain('マネージャー mgr-nothing は居ない');
      expect(reply).not.toContain('読めない');
    });
  });

  it('対照: 読める行は今までどおり 200', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    await captureStderr(async () => {
      const result = await getManager(stores, 'mgr-good');
      expect(result.status).toBe(200);
    });
  });
});
