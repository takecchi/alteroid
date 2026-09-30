import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createManagerPool,
  createRunnerRegistry,
  describeUnreadableApprovals,
} from '@alteroid/core';
import type { CloneHost, PendingApproval, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables, type Db, type PgStores } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * `JobStore.listApprovals()` の、読めない（`pendingApprovalSchema` に合わない）行の扱い
 * （#2298。#2279 の `getApproval` / `updateApproval` の続き。台帳の `CommitmentList.unreadable`
 * と同じ形）。
 *
 * 直す前は fs も pg も、読めない行を件数も跡も残さずに飛ばし、`GET /approvals` にも
 * 何も出なかった。今は `unreadable` に別欄で返し、pg は stderr に跡を残す。
 *
 * fs / pg の2実装を並べる（pg は PGlite）。**メモリ実装は並べない**——`putApproval` が
 * スキーマを通すので、壊れた行を保持できない。
 */

const BAD_QUESTION = '壊れた承認の質問（この文字列は応答にも跡にも出てはいけない）';

// createdAt が日時の形でない——版ずれ・手編集を模す。
const BAD_APPROVAL_RAW = {
  id: 'ap-bad',
  createdAt: 'not-a-date-from-a-newer-deploy',
  question: BAD_QUESTION,
};

// 回答済みの印（answeredAt）を持つが、他が壊れている行。`pendingOnly` では除かれる側。
const BAD_SETTLED_RAW = {
  id: 'ap-bad-settled',
  createdAt: 'not-a-date',
  question: BAD_QUESTION,
  answeredAt: '2026-09-02T01:00:00.000Z',
};

const GOOD_APPROVAL: PendingApproval = {
  id: 'ap-good',
  createdAt: '2026-09-02T00:00:00.000Z',
  question: '読める承認の質問',
};

function fakeCloneHost(stores: Stores): CloneHost {
  return {
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function appOver(stores: Stores) {
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
  });
}

async function getApprovals(stores: Stores, query = ''): Promise<Record<string, unknown>> {
  const response = await appOver(stores).request(`/approvals${query}`, {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** fs / pg 共通: 一覧・pendingOnly・HTTP を測る。 */
async function expectListShowsUnreadable(stores: Stores): Promise<void> {
  const all = await stores.jobs.listApprovals();
  expect(all.entries).toEqual([GOOD_APPROVAL]);
  expect(all.unreadable.map((row) => row.id)).toContain('ap-bad');
  // 本文は載せない。理由は「不正な欄」だけ。
  expect(JSON.stringify(all.unreadable)).not.toContain(BAD_QUESTION);
  const bad = all.unreadable.find((row) => row.id === 'ap-bad');
  expect(bad?.reason).toContain('createdAt');

  // 回答済みの印が見える壊れた行は、保留だけの一覧では数えない。
  const pending = await stores.jobs.listApprovals({ pendingOnly: true });
  expect(pending.entries).toEqual([GOOD_APPROVAL]);
  expect(pending.unreadable.map((row) => row.id)).toEqual(['ap-bad']);

  // HTTP: 読めた行は今までどおり、読めない行は `unreadable` に。
  const body = await getApprovals(stores);
  expect((body.approvals as { id: string }[]).map((a) => a.id)).toEqual(['ap-good']);
  expect(body.unreadable).toEqual([{ id: 'ap-bad', reason: expect.stringContaining('createdAt') }]);
  expect(JSON.stringify(body)).not.toContain(BAD_QUESTION);
  // `limit` の窓でも切らない。
  const windowed = await getApprovals(stores, '?order=asc&limit=1');
  expect((windowed.unreadable as unknown[]).length).toBe(1);
}

// PGlite の雛形（WASM の起動＋migrate）は、ワーカーで最初に呼んだ歯が払う。
// 歯の本体（既定 5000ms）でなく hook（明示 30_000ms）で払わせる（issue #2378、#2360 / #2364 と同じ形）。
// このファイルは `new PGlite()` + `migrate` を歯の中で直に呼んでいたので、雛形（`createMigratedPglite`）へ寄せた。
// 各歯が「空の、migrate 済みの、自分専用の PGlite」から始まること、`afterEach` で閉じることは変わらない。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe('JobStore.listApprovals() — 読めない承認の行の扱い（#2298）', () => {
  describe('fs 実装', () => {
    async function seed(rows: unknown[]) {
      const root = await makeTempDir('alteroid-test-');
      const dir = join(root, 'jobs');
      const jobsPath = join(dir, 'jobs.json');
      await mkdir(dir, { recursive: true });
      await writeFile(jobsPath, `${JSON.stringify({ jobs: [], approvals: rows }, null, 2)}\n`);
      return { jobsPath, stores: createFsStores(root) };
    }

    it('読めない行は unreadable に返る。読めた行は今までどおり。ファイルは書き換えない', async () => {
      const { jobsPath, stores } = await seed([BAD_APPROVAL_RAW, BAD_SETTLED_RAW, GOOD_APPROVAL]);
      const before = await readFile(jobsPath, 'utf8');
      await captureStderr(async () => {
        await expectListShowsUnreadable(stores);
        const all = await stores.jobs.listApprovals();
        expect(all.unreadable.map((row) => row.id)).toEqual(['ap-bad', 'ap-bad-settled']);
      });
      expect(await readFile(jobsPath, 'utf8')).toBe(before);
    });

    it('id が取れない行は id 無しで数える', async () => {
      const { stores } = await seed([{ question: BAD_QUESTION }, 'not-an-object', GOOD_APPROVAL]);
      let list: Awaited<ReturnType<typeof stores.jobs.listApprovals>> | undefined;
      await captureStderr(async () => {
        list = await stores.jobs.listApprovals();
      });
      expect(list?.entries).toEqual([GOOD_APPROVAL]);
      expect(list?.unreadable).toHaveLength(2);
      expect(list?.unreadable.every((row) => row.id === undefined)).toBe(true);
      expect(JSON.stringify(list?.unreadable)).not.toContain(BAD_QUESTION);
    });

    it('読めない行が無いとき unreadable は空で、HTTP は鍵ごと出さない', async () => {
      const { stores } = await seed([GOOD_APPROVAL]);
      const list = await stores.jobs.listApprovals();
      expect(list).toEqual({ entries: [GOOD_APPROVAL], unreadable: [] });
      const body = await getApprovals(stores);
      expect('unreadable' in body).toBe(false);
    });
  });

  describe('pg 実装', () => {
    let client: PGlite;
    let db: Db;
    let stores: PgStores;

    afterEach(async () => {
      await client.close();
    });

    async function seed(withBad: boolean) {
      ({ client, db } = await createMigratedPglite());
      stores = createPgStoresFromDb(db);
      await stores.jobs.putApproval(GOOD_APPROVAL);
      if (!withBad) return;
      // 行を直接 insert する——`putApproval()` は `pendingApprovalSchema.parse` を通す。
      await db.insert(tables.approvals).values({
        id: BAD_APPROVAL_RAW.id,
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
        answeredAt: null,
        withdrawnAt: null,
        approval: BAD_APPROVAL_RAW,
      });
      await db.insert(tables.approvals).values({
        id: BAD_SETTLED_RAW.id,
        createdAt: new Date('2026-09-02T00:00:01.000Z'),
        answeredAt: new Date(BAD_SETTLED_RAW.answeredAt),
        withdrawnAt: null,
        approval: BAD_SETTLED_RAW,
      });
    }

    it('読めない行は unreadable に返る。読めた行は今までどおり', async () => {
      await seed(true);
      let all: Awaited<ReturnType<typeof stores.jobs.listApprovals>> | undefined;
      await captureStderr(async () => {
        await expectListShowsUnreadable(stores);
        all = await stores.jobs.listApprovals();
      });
      expect(all?.unreadable.map((row) => row.id)).toEqual(['ap-bad', 'ap-bad-settled']);
    });

    it('一覧・getApproval・updateApproval は、読めない行について stderr に id つきの跡を残す（本文は出さない）', async () => {
      await seed(true);
      const listTrace = await captureStderr(async () => {
        await stores.jobs.listApprovals({ pendingOnly: true });
      });
      expect(listTrace.join('')).toContain('listApprovals');
      expect(listTrace.join('')).toContain('ap-bad');

      const getTrace = await captureStderr(async () => {
        await stores.jobs.getApproval('ap-bad').catch(() => undefined);
      });
      expect(getTrace.join('')).toContain('getApproval');
      expect(getTrace.join('')).toContain('ap-bad');

      const updateTrace = await captureStderr(async () => {
        await stores.jobs.updateApproval('ap-bad', (c) => c).catch(() => undefined);
      });
      expect(updateTrace.join('')).toContain('updateApproval');
      expect(updateTrace.join('')).toContain('ap-bad');

      for (const trace of [listTrace, getTrace, updateTrace]) {
        expect(trace.join('')).not.toContain(BAD_QUESTION);
      }
    });

    it('読めない行が無いとき unreadable は空で、跡も出ない。HTTP は鍵ごと出さない', async () => {
      await seed(false);
      let list: Awaited<ReturnType<typeof stores.jobs.listApprovals>> | undefined;
      const trace = await captureStderr(async () => {
        list = await stores.jobs.listApprovals();
      });
      expect(list).toEqual({ entries: [GOOD_APPROVAL], unreadable: [] });
      expect(trace).toEqual([]);
      const body = await getApprovals(stores);
      expect('unreadable' in body).toBe(false);
    });
  });
});

describe('describeUnreadableApprovals — クローンと digest が使う1文', () => {
  it('0件は null（何も出さない）', () => {
    expect(describeUnreadableApprovals([])).toBeNull();
  });

  it('件数と id、回答済みではないこと、id が取れない行の数を言う', () => {
    const note = describeUnreadableApprovals([{ id: 'a', reason: 'r' }, { reason: 'r' }]);
    expect(note).toContain('読めない承認待ちが 2 件ある');
    expect(note).toContain('id: a');
    expect(note).toContain('id が取れない行が 1 件');
    expect(note).toContain('回答済み・取り下げ済みではない');
  });

  it('id が全部取れないときはそう言う。id は上限で切って、切ったと言う', () => {
    expect(describeUnreadableApprovals([{ reason: 'r' }])).toContain('id も取れない');
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, reason: 'r' }));
    const note = describeUnreadableApprovals(many);
    expect(note).toContain('読めない承認待ちが 12 件ある');
    expect(note).toContain('ほか 2 件');
    expect(note).not.toContain('x11');
  });
});
