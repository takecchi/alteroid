import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, createCloneTools } from '@alteroid/core';
import type { CloneHost, InboxEvent, ManagerPool, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

const BAD_TEXT = '壊れた合図の本文（この文字列はどの出力にも出てはいけない）';

const GOOD_EVENT = {
  type: 'human_message',
  id: 'evt-good',
  at: '2026-09-28T00:00:00.000Z',
  text: '読める合図の本文',
  conversationId: 'conv-1',
} as unknown as InboxEvent;

const BAD_EVENT_RAW = { type: 'not-a-real-event-type', id: 'evt-bad', text: BAD_TEXT };
const BAD_AT = '2026-09-27T00:00:00.000Z';

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
      const path = join(root, 'jobs', 'inbox.json');
      let raw: { events: unknown[] } = { events: [] };
      try {
        raw = JSON.parse(await readFile(path, 'utf8')) as typeof raw;
      } catch {
        // まだファイルが無い（0件から始めるとき）。
      }
      raw.events.push({ event: BAD_EVENT_RAW, at: BAD_AT, deliveries: 0 });
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
      // 行を直接 insert する: `put()` は `inboxEventSchema.parse` を通すため。
      await db.insert(tables.inboxEvents).values({
        id: 'evt-bad',
        event: BAD_EVENT_RAW,
        at: new Date(BAD_AT),
        deliveries: 0,
      });
    },
  };
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

async function getInbox(stores: Stores): Promise<Record<string, unknown>> {
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request('/inbox', {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function tool(stores: Stores, name: string): (args: Record<string, unknown>) => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    managers: { list: async () => [], runnerBacklog: () => [] } as unknown as ManagerPool,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} が無い`);
  return async (args) => {
    const result = await found.handler(args as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

// 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)(
  '受信箱が読めない行を「未処理の合図は無い」と言わない（%s 実装。#2344）',
  (_label, seed) => {
    it('peekPending(): 読めた行は entries、読めない行は unreadable に id・受信時刻・不正な欄名だけで返る', async () => {
      const { stores, addBadRow } = await seed();
      await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
      await addBadRow();

      let peek: Awaited<ReturnType<Stores['inbox']['peekPending']>> | undefined;
      await captureStderr(async () => {
        peek = await stores.inbox.peekPending();
      });

      expect(peek?.entries.map((row) => row.event.id)).toEqual(['evt-good']);
      expect(peek?.unreadable).toEqual([
        { id: 'evt-bad', at: BAD_AT, reason: '不正な欄: event.type' },
      ]);
      expect(JSON.stringify(peek?.unreadable)).not.toContain(BAD_TEXT);
      expect((await stores.inbox.pending()).count).toBe(2);
    });

    it('manager_list: 読めた行に加えて「読めない合図が 1 件ある」と言う', async () => {
      const { stores, addBadRow } = await seed();
      await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
      await addBadRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await tool(stores, 'manager_list')({});
      });

      expect(reply).toContain('クローンの受信箱に未処理の合図が 1 件ある');
      expect(reply).toContain('読めない合図が 1 件ある（id: evt-bad）');
      expect(reply).toContain('処理済みで消えたのではない');
      expect(reply).not.toContain(BAD_TEXT);
    });

    it('manager_list: 読めた行が0件でも「クローンの受信箱に未処理の合図は無い。」と言わない', async () => {
      const { stores, addBadRow } = await seed();
      await addBadRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await tool(stores, 'manager_list')({});
      });

      expect(reply).not.toContain('未処理の合図は無い。');
      expect(reply).toContain('読めた未処理の合図は無い（ただし、読めない行が在る');
      expect(reply).toContain('読めない合図が 1 件ある（id: evt-bad）');
    });

    it('inbox_remove_many: 読めた未読が0件でも「受信箱に未読が1件も無い」と言わない（1件も消さない）', async () => {
      const { stores, addBadRow } = await seed();
      await addBadRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await tool(
          stores,
          'inbox_remove_many',
        )({ types: ['manager_message'], reason: 'x' });
      });

      expect(reply).not.toContain('受信箱に未読が1件も無い');
      expect(reply).toContain('読めない合図が 1 件ある（id: evt-bad）');
      expect(reply).toContain('1件も消していない');
      expect((await stores.inbox.pending()).count).toBe(1);
    });

    it('GET /inbox: unreadable を載せる。total は読めた行の数のまま', async () => {
      const { stores, addBadRow } = await seed();
      await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
      await addBadRow();

      let body: Record<string, unknown> = {};
      await captureStderr(async () => {
        body = await getInbox(stores);
      });

      expect(body.total).toBe(1);
      expect(body.unreadable).toEqual([
        { id: 'evt-bad', at: BAD_AT, reason: '不正な欄: event.type' },
      ]);
      expect(JSON.stringify(body)).not.toContain(BAD_TEXT);
    });

    it('GET /inbox: 壊れた行しか無くても total: 0 に unreadable が付く（空の応答とは区別できる）', async () => {
      const { stores, addBadRow } = await seed();
      await addBadRow();

      let body: Record<string, unknown> = {};
      await captureStderr(async () => {
        body = await getInbox(stores);
      });

      expect(body.total).toBe(0);
      expect(body.unreadable).toEqual([
        { id: 'evt-bad', at: BAD_AT, reason: '不正な欄: event.type' },
      ]);
    });

    it('対照: 本当に0件なら「無い」と言い、読めない行の文言も鍵も出ない', async () => {
      const { stores } = await seed();

      expect(await tool(stores, 'manager_list')({})).toContain(
        'クローンの受信箱に未処理の合図は無い。',
      );
      expect(await tool(stores, 'manager_list')({})).not.toContain('読めない');
      expect(
        await tool(stores, 'inbox_remove_many')({ types: ['manager_message'], reason: 'x' }),
      ).toContain('受信箱に未読が1件も無い');
      const body = await getInbox(stores);
      expect(body.total).toBe(0);
      expect('unreadable' in body).toBe(false);
    });

    it('対照: 読める行だけなら、読めない行の文言も鍵も出ない', async () => {
      const { stores } = await seed();
      await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');

      expect(await tool(stores, 'manager_list')({})).not.toContain('読めない');
      const body = await getInbox(stores);
      expect('unreadable' in body).toBe(false);
    });
  },
);
