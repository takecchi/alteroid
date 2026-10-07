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
  readBadRow(): Promise<string>;
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
    readBadRow: () => readFile(path, 'utf8'),
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
    async readBadRow() {
      const rows = await db.select().from(tables.jobs);
      return JSON.stringify(rows.filter((row) => row.id === BAD_JOB_RAW.id));
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

interface HttpResult {
  status: number;
  raw: string;
  body: Record<string, unknown>;
}

async function http(
  stores: Stores,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  json?: unknown,
): Promise<HttpResult> {
  const app = createApp({
    clone: stubCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request(path, {
    method,
    headers: {
      authorization: 'Bearer test-token',
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // JSON でない応答（生ログの本文など）。
  }
  return { status: response.status, raw, body };
}

function tool(
  stores: Stores,
  name: 'manager_stop' | 'manager_send' | 'manager_transcript',
): (input: Record<string, unknown>) => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: poolOver(stores),
  });
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} が無い`);
  return async (input) => {
    const result = await found.handler(input as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

function expectUnreadableWording(text: string): void {
  expect(text).not.toContain('居ない');
  expect(text).toContain('マネージャー mgr-bad は読めない形で入っている');
  expect(text).toContain('不正な欄: status');
  expect(text).not.toContain(BAD_SUMMARY);
}

// 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('止める・送る・生ログを読む口（%s。#2359）', (_label, seed) => {
  async function withBadRow(): Promise<Seeded> {
    const seeded = await seed();
    await seeded.stores.jobs.putJob(GOOD);
    await seeded.addBadRow();
    return seeded;
  }

  it('manager_stop: 読めない行の id を「居ない」と言わず、止めていないと言う。行は変えない', async () => {
    const { stores, readBadRow } = await withBadRow();
    const before = await readBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await tool(stores, 'manager_stop')({ managerId: 'mgr-bad', reason: '確認' });
    });

    expectUnreadableWording(reply);
    expect(reply).toContain('止めていない');
    expect(await readBadRow()).toBe(before);
  });

  it('DELETE /managers/:id: 読めない行の id は 409。本文は含まない。行は変えない', async () => {
    const { stores, readBadRow } = await withBadRow();
    const before = await readBadRow();

    let result: HttpResult | undefined;
    await captureStderr(async () => {
      result = await http(stores, 'DELETE', '/managers/mgr-bad');
    });

    expect(result?.status).toBe(409);
    expectUnreadableWording(String(result?.body.error));
    expect(result?.raw).not.toContain(BAD_SUMMARY);
    expect(await readBadRow()).toBe(before);
  });

  it('manager_send: 読めない行の id を「居ない」と言わず、送っていないと言う', async () => {
    const { stores, readBadRow } = await withBadRow();
    const before = await readBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await tool(stores, 'manager_send')({ managerId: 'mgr-bad', message: 'やって' });
    });

    expectUnreadableWording(reply);
    expect(reply).toContain('送っていない');
    expect(await readBadRow()).toBe(before);
  });

  it('POST /managers/:id/messages: 読めない行の id は 409。本文は含まない', async () => {
    const { stores } = await withBadRow();

    let result: HttpResult | undefined;
    await captureStderr(async () => {
      result = await http(stores, 'POST', '/managers/mgr-bad/messages', { text: 'やって' });
    });

    expect(result?.status).toBe(409);
    expectUnreadableWording(String(result?.body.error));
    expect(result?.raw).not.toContain(BAD_SUMMARY);
  });

  it('manager_transcript: 読めない行の id を「生ログは無い」「居ない」と言わず、読めない形で在ると言う', async () => {
    const { stores } = await withBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await tool(stores, 'manager_transcript')({ managerId: 'mgr-bad' });
    });

    expectUnreadableWording(reply);
    expect(reply).not.toContain('生ログは無い');
  });

  it('GET /managers/:id/transcript: 読めない行の id は 404 ではなく 409。本文は含まない', async () => {
    const { stores } = await withBadRow();

    let result: HttpResult | undefined;
    await captureStderr(async () => {
      result = await http(stores, 'GET', '/managers/mgr-bad/transcript');
    });

    expect(result?.status).toBe(409);
    expectUnreadableWording(String(result?.body.error));
    expect(result?.raw).not.toContain(BAD_SUMMARY);
  });

  it('対照: 本当に無い id は、今までどおり「居ない」と 404（読めない行が別に在っても）', async () => {
    const { stores } = await withBadRow();

    await captureStderr(async () => {
      const stop = await http(stores, 'DELETE', '/managers/mgr-nothing');
      expect(stop.status).toBe(404);
      expect(String(stop.body.error)).toContain('mgr-nothing というマネージャーは居ない');
      expect(String(stop.body.error)).not.toContain('読めない');

      const send = await http(stores, 'POST', '/managers/mgr-nothing/messages', { text: 'やって' });
      expect(send.status).toBe(404);
      expect(String(send.body.error)).toContain('mgr-nothing というマネージャーは居ない');
      expect(String(send.body.error)).not.toContain('読めない');

      const transcript = await http(stores, 'GET', '/managers/mgr-nothing/transcript');
      expect(transcript.status).toBe(404);
      expect(transcript.body).toEqual({ error: 'not found' });

      const stopReply = await tool(stores, 'manager_stop')({ managerId: 'mgr-nothing' });
      expect(stopReply).toContain('mgr-nothing は居ない');
      expect(stopReply).not.toContain('読めない');

      const sendReply = await tool(
        stores,
        'manager_send',
      )({ managerId: 'mgr-nothing', message: 'やって' });
      expect(sendReply).toContain('mgr-nothing というマネージャーは居ない');
      expect(sendReply).not.toContain('読めない');

      const transcriptReply = await tool(
        stores,
        'manager_transcript',
      )({ managerId: 'mgr-nothing' });
      expect(transcriptReply).toContain('マネージャー mgr-nothing の生ログは無い');
      expect(transcriptReply).not.toContain('読めない');
    });
  });
});
