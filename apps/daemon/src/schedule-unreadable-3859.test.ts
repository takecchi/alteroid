import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, createCloneTools } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

/**
 * Issue #3859。読めない行（`plan.spec.type` が未知の値）の kind へ `POST /schedule` /
 * `schedule_create` すると、fs は「無い」扱いで黙って壊れた行を置き換え、pg は
 * `UnreadableScheduleError` が 500 まで落ちていた。fs・pg とも「読めない行なので編集できない」
 * と分かる 409 / 文言で断り、行は書き換えない。外してから作り直せば通る。
 */

const BAD = 'bad-schedule';
const BAD_REQUEST_TEXT = '壊れた行の本文（応答に出てはいけない）';
const spec = { type: 'daily', at: '09:00' } as const;

const badPlan = {
  kind: BAD,
  spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
  request: BAD_REQUEST_TEXT,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

async function fsStores(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.schedules.put({
    kind: 'good',
    spec,
    request: '読める行',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  const path = join(root, 'jobs', 'schedules.json');
  const file = JSON.parse(await readFile(path, 'utf8')) as { schedules: unknown[] };
  file.schedules.push(badPlan);
  await writeFile(path, JSON.stringify(file), 'utf8');
  return stores;
}

async function pgStores(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  await db.insert(tables.schedules).values({
    kind: BAD,
    createdAt: new Date(badPlan.createdAt),
    updatedAt: new Date(badPlan.updatedAt),
    plan: badPlan,
  });
  return createPgStoresFromDb(db);
}

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function decisions(stores: Stores): Promise<string[]> {
  return (await stores.journal.list({ types: ['decision'] })).flatMap((entry) =>
    entry.type === 'decision' ? [entry.decision] : [],
  );
}

describe.each([
  ['fs', fsStores],
  ['pg', pgStores],
] as const)('読めない予定の行への編集は 4xx で断る（%s 実装。Issue #3859）', (_label, make) => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    stores = await make();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
  });

  it('POST /schedule は 409 で、読めない行なので編集できないと分かる。何も書かず、打ち消しの日誌が残る', async () => {
    await captureStderr(async () => {
      for (const extra of [{}, { ifMatch: null }, { ifMatch: badPlan.updatedAt }]) {
        const response = await app.request(
          '/schedule',
          json({ kind: BAD, request: '直したい', spec, ...extra }),
        );
        const body = (await response.json()) as { error: string };
        expect(response.status, JSON.stringify(body)).toBe(409);
        expect(body.error).toContain('読めない形');
        expect(body.error).toContain('編集できない');
        expect(body.error).toContain(`DELETE /schedule/${BAD}`);
        expect(JSON.stringify(body)).not.toContain(BAD_REQUEST_TEXT);
      }
      // 行は壊れたまま（黙って置き換えていない）
      await expect(stores.schedules.get(BAD)).rejects.toMatchObject({
        name: 'UnreadableScheduleError',
      });
      expect((await decisions(stores)).some((d) => d.includes('読めない形で入っている'))).toBe(
        true,
      );

      // 外してから作り直せば通る
      const removed = await app.request(`/schedule/${BAD}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(removed.status).toBe(200);
      const created = await app.request(
        '/schedule',
        json({ kind: BAD, request: '作り直し', spec }),
      );
      expect(created.status).toBe(200);
      expect((await stores.schedules.get(BAD))?.request).toBe('作り直し');
    });
  });

  it('schedule_create は例外を落とさず、理由の分かる文で返し、行は書き換えない', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const tool = tools.find((entry) => entry.name === 'schedule_create');
    if (!tool) throw new Error('schedule_create が無い');
    await captureStderr(async () => {
      const result = await tool.handler(
        { kind: BAD, request: '直したい', dailyAt: '09:00' } as never,
        {},
      );
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      expect(text).toContain('読めない形');
      expect(text).toContain('編集できない');
      expect(text).toContain(`schedule_remove kind=${BAD}`);
      expect(text).not.toContain(BAD_REQUEST_TEXT);
      await expect(stores.schedules.get(BAD)).rejects.toMatchObject({
        name: 'UnreadableScheduleError',
      });
    });
  });
});
