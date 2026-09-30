import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildActivityDigest,
  captureStderr,
  createCloneTools,
  createScheduler,
} from '@alteroid/core';
import type { CloneHost, ScheduledRequest, Scheduler, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #2343。`ScheduleStore.list()` は、読めない（`scheduledRequestSchema` に合わない）
 * 行を stderr に1行書くだけで黙って飛ばしていたので、上の層はどれも「依頼は無い」と言い
 * 切れた。今は `{ entries, unreadable }` で返し、各層がそれを「読めない N 件」として出す
 * （承認待ちの `approval-unreadable-list.test.ts` と同じ形。#2298）。
 *
 * fs / pg の2実装を並べ、**実物のストアに不正な行を1行だけ置いた状態から**、次の層を通す。
 *
 * - `ScheduleStore.list()` — `unreadable` に kind と不正な欄名だけ（本文は載せない）
 * - 道具 `schedule_list`（一覧）— 「読めない継続中の依頼が 1 件ある」。読めた行が0件でも
 *   「（継続中の依頼は無い）」と言わない
 * - 発意 tick の digest — 件数の行と節
 * - `GET /schedule`（本物のスケジューラ越し）— `unreadable` を載せる
 *
 * 対照: 本当に0件なら「無い」と言い、`unreadable` の鍵も出さない。
 *
 * **メモリ実装は並べない**——`put()` がスキーマを通すので、壊れた行を持てない。
 * CLI と Web は HTTP の応答を描くだけなので、それぞれ `chat.test.ts` /
 * `schedule.test.tsx` / `dashboard.test.tsx` が応答の形を差して測る。
 */

const BAD_REQUEST_TEXT = '壊れた継続中の依頼の本文（この文字列はどの出力にも出てはいけない）';

const GOOD: ScheduledRequest = {
  kind: 'good-kind',
  spec: { type: 'every', minutes: 60 },
  request: '読める継続中の依頼の本文',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

// `spec.type` が既知の値でない——版ずれ・手編集を模す。
const BAD_PLAN_RAW = {
  kind: 'bad-kind',
  spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
  request: BAD_REQUEST_TEXT,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

interface Seeded {
  stores: Stores;
  /** 不正な行を1行だけ足す（呼ぶ前は読める行だけ）。 */
  addBadRow(): Promise<void>;
}

async function seedFs(): Promise<Seeded> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  return {
    stores,
    async addBadRow() {
      const path = join(root, 'jobs', 'schedules.json');
      let raw: { schedules: unknown[]; phases: unknown[] } = { schedules: [], phases: [] };
      try {
        raw = JSON.parse(await readFile(path, 'utf8')) as typeof raw;
      } catch {
        // まだファイルが無い（0件から始めるとき）。
      }
      raw.schedules.push(BAD_PLAN_RAW);
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
      // 行を直接 insert する——`put()` は `scheduledRequestSchema.parse` を通す。
      await db.insert(tables.schedules).values({
        kind: BAD_PLAN_RAW.kind,
        createdAt: new Date(BAD_PLAN_RAW.createdAt),
        updatedAt: new Date(BAD_PLAN_RAW.updatedAt),
        plan: BAD_PLAN_RAW,
      });
    },
  };
}

function stubCloneHost(): CloneHost {
  return {
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

/** 本物のスケジューラ（ストアを読み直す）越しに `GET /schedule` を引く。 */
async function getSchedule(stores: Stores): Promise<Record<string, unknown>> {
  const scheduler: Scheduler = createScheduler({
    entries: [],
    post: () => undefined,
    schedules: stores.schedules,
  });
  await scheduler.refresh();
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    scheduler,
  });
  const response = await app.request('/schedule', {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function scheduleListTool(stores: Stores): () => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  const tool = tools.find((entry) => entry.name === 'schedule_list');
  if (!tool) throw new Error('schedule_list が無い');
  return async () => {
    const result = await tool.handler({} as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

const since = () => new Date(Date.now() - 60_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)(
  '継続中の依頼の一覧が読めない行を「無い」と言わない（%s 実装。#2343）',
  (_label, seed) => {
    it('list(): 読めた行は entries、読めない行は unreadable に kind と不正な欄名だけで返る', async () => {
      const { stores, addBadRow } = await seed();
      await stores.schedules.put(GOOD);
      await addBadRow();

      let list: Awaited<ReturnType<Stores['schedules']['list']>> | undefined;
      await captureStderr(async () => {
        list = await stores.schedules.list();
      });

      expect(list?.entries.map((entry) => entry.kind)).toEqual(['good-kind']);
      expect(list?.unreadable).toEqual([{ kind: 'bad-kind', reason: '不正な欄: spec' }]);
      expect(JSON.stringify(list?.unreadable)).not.toContain(BAD_REQUEST_TEXT);
    });

    it('schedule_list: 読めた行に加えて「読めない継続中の依頼が 1 件ある」と言う', async () => {
      const { stores, addBadRow } = await seed();
      await stores.schedules.put(GOOD);
      await addBadRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await scheduleListTool(stores)();
      });

      expect(reply).toContain('読める継続中の依頼の本文');
      expect(reply).toContain('読めない継続中の依頼が 1 件ある（kind: bad-kind）');
      expect(reply).toContain('消された依頼ではない');
      expect(reply).not.toContain(BAD_REQUEST_TEXT);
    });

    it('schedule_list: 読めた行が0件でも「（継続中の依頼は無い）」と言わない', async () => {
      const { stores, addBadRow } = await seed();
      await addBadRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await scheduleListTool(stores)();
      });

      expect(reply).not.toContain('（継続中の依頼は無い）');
      expect(reply).toContain('（読めた継続中の依頼は無い）');
      expect(reply).toContain('読めない継続中の依頼が 1 件ある（kind: bad-kind）');
    });

    it('digest: 件数の行と節で「読めない継続中の依頼」を言う。読めた依頼は今までどおり', async () => {
      const { stores, addBadRow } = await seed();
      await stores.schedules.put(GOOD);
      await addBadRow();

      let digest = '';
      await captureStderr(async () => {
        digest = await buildActivityDigest(stores, { since: since() });
      });

      expect(digest).toContain('- 継続中の依頼（定期の仕込み）: 1 件');
      expect(digest).toContain(
        '- 読めない継続中の依頼（壊れた行。上の件数には入っていない）: 1 件',
      );
      expect(digest).toContain('読めない継続中の依頼が 1 件ある（kind: bad-kind）');
      expect(digest).toContain('読める継続中の依頼の本文');
      expect(digest).not.toContain(BAD_REQUEST_TEXT);
    });

    it('digest: 読めた依頼が0件でも、読めない行の節は出る', async () => {
      const { stores, addBadRow } = await seed();
      await addBadRow();

      let digest = '';
      await captureStderr(async () => {
        digest = await buildActivityDigest(stores, { since: since() });
      });

      expect(digest).toContain('## 継続中の依頼');
      expect(digest).toContain('読めない継続中の依頼が 1 件ある（kind: bad-kind）');
    });

    it('GET /schedule: unreadable を載せる。読めた行は entries に今までどおり出る', async () => {
      const { stores, addBadRow } = await seed();
      await stores.schedules.put(GOOD);
      await addBadRow();

      let body: Record<string, unknown> = {};
      await captureStderr(async () => {
        body = await getSchedule(stores);
      });

      expect((body.entries as { kind: string }[]).map((entry) => entry.kind)).toEqual([
        'good-kind',
      ]);
      expect(body.unreadable).toEqual([{ kind: 'bad-kind', reason: '不正な欄: spec' }]);
      expect(JSON.stringify(body)).not.toContain(BAD_REQUEST_TEXT);
    });

    it('対照: 本当に0件なら「無い」と言い、読めない行の文言も鍵も出ない', async () => {
      const { stores } = await seed();

      expect(await scheduleListTool(stores)()).toBe('（継続中の依頼は無い）');
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).not.toContain('読めない継続中の依頼');
      expect(digest).not.toContain('## 継続中の依頼');
      const body = await getSchedule(stores);
      expect('unreadable' in body).toBe(false);
    });

    it('対照: 読める行だけなら、読めない行の文言も鍵も出ない', async () => {
      const { stores } = await seed();
      await stores.schedules.put(GOOD);

      expect(await scheduleListTool(stores)()).not.toContain('読めない');
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).not.toContain('読めない継続中の依頼');
      const body = await getSchedule(stores);
      expect('unreadable' in body).toBe(false);
    });
  },
);
