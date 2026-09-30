import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createCloneTools,
  createManagerPool,
  createRunnerRegistry,
} from '@alteroid/core';
import type { CloneHost, Job, ManagerPool, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #2359 の3。`GET /appraisal-stats` と道具 `appraisal_stats` の `jobCoverage` は
 * `listJobs()` から数えるので、読めない委譲の行は内訳（評定あり／なし）にも合計にも
 * 入らず、分母が欠けていることも言わなかった。読めない行は、終端したかも評定の有無も
 * 分からない。今は `jobCoverage.unreadableJobs`（件数。0 も載せる）と、0 でないときだけ
 * 出る1文で言う。内訳（評定なし・評定あり）には推測で入れない。
 *
 * fs / pg の2実装に、実物のストアへ不正な行を1行だけ置いた状態から通す。
 */

const BAD_SUMMARY = '壊れた委譲の本文（この文字列はどの出力にも出てはいけない）';

// 終端した読める委譲（評定なし）。
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

interface Coverage {
  byStatus: { status: string; total: number; appraised: number; unappraised: number }[];
  terminalTotal: number;
  terminalAppraised: number;
  terminalUnappraised: number;
  nonTerminalTotal: number;
  unreadableJobs: number;
}

async function getCoverage(stores: Stores): Promise<Coverage> {
  const app = createApp({
    clone: stubCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request('/appraisal-stats', {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { jobCoverage: Coverage }).jobCoverage;
}

function appraisalStatsTool(stores: Stores): () => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: poolOver(stores),
  });
  const tool = tools.find((entry) => entry.name === 'appraisal_stats');
  if (!tool) throw new Error('appraisal_stats が無い');
  return async () => {
    const result = await tool.handler({} as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('評定の集計が、読めない委譲の欠けを言う（%s。#2359）', (_label, seed) => {
  it('GET /appraisal-stats: unreadableJobs に数え、内訳・合計には入れない', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let coverage: Coverage | undefined;
    await captureStderr(async () => {
      coverage = await getCoverage(stores);
    });

    expect(coverage?.unreadableJobs).toBe(1);
    // 読めた終端の委譲1件（評定なし）だけが内訳に居る。読めない行は評定なしにも入らない。
    expect(coverage?.terminalTotal).toBe(1);
    expect(coverage?.terminalUnappraised).toBe(1);
    expect(coverage?.terminalAppraised).toBe(0);
    expect(coverage?.nonTerminalTotal).toBe(0);
    expect(coverage?.byStatus.reduce((sum, row) => sum + row.total, 0)).toBe(1);
    expect(JSON.stringify(coverage)).not.toContain(BAD_SUMMARY);
  });

  it('appraisal_stats: 「読めない委譲が 1 件あり、上の内訳には入っていない」と言う', async () => {
    const { stores, addBadRow } = await seed();
    await stores.jobs.putJob(GOOD);
    await addBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await appraisalStatsTool(stores)();
    });

    expect(reply).toContain('※ 読めない委譲が 1 件あり、上の内訳には入っていない');
    expect(reply).toContain('終端したかも、評定の有無も分からない');
    expect(reply).toContain('上の件数は読めた委譲だけから数えている');
    // 内訳は読めた委譲1件のまま（読めない行を足して 2 件にしない）。
    expect(reply).toContain('合計: 終端した委譲 1 件中、評定なしが 1 件（評定あり 0 件）。');
    expect(reply).not.toContain(BAD_SUMMARY);
  });

  it('読めた行が0件でも、0件の内訳に並べて件数を言う', async () => {
    const { stores, addBadRow } = await seed();
    await addBadRow();

    let coverage: Coverage | undefined;
    let reply = '';
    await captureStderr(async () => {
      coverage = await getCoverage(stores);
      reply = await appraisalStatsTool(stores)();
    });

    expect(coverage?.unreadableJobs).toBe(1);
    expect(coverage?.terminalTotal).toBe(0);
    expect(reply).toContain('合計: 終端した委譲 0 件中、評定なしが 0 件（評定あり 0 件）。');
    expect(reply).toContain('※ 読めない委譲が 1 件あり、上の内訳には入っていない');
  });

  it('対照: 読めない委譲が無ければ、unreadableJobs は 0 で載り、文は増えない', async () => {
    const { stores } = await seed();
    await stores.jobs.putJob(GOOD);

    const coverage = await getCoverage(stores);
    expect(coverage.unreadableJobs).toBe(0);
    expect(coverage.terminalTotal).toBe(1);
    const reply = await appraisalStatsTool(stores)();
    expect(reply).not.toContain('読めない委譲');
    expect(reply).toContain('合計: 終端した委譲 1 件中、評定なしが 1 件（評定あり 0 件）。');
  });
});
