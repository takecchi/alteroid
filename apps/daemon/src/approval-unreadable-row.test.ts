import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createManagerPool,
  createRunnerRegistry,
  UnreadableApprovalError,
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
 * `JobStore.getApproval()` / `updateApproval()` の、読めない（`pendingApprovalSchema` に
 * 合わない）行に対する扱い（#2279。#2262 の `UnreadableJobError` と同じ形）。
 *
 * 直す前は、行は在るのに「無い」と同じ `null` を返し、呼び出し元が「存在しない」
 * （HTTP は 404 `not found`）と言い切っていた。今は `UnreadableApprovalError` を投げて
 * 「無い」（`null`）と分け、HTTP は 409 で「在るが読めない」と言う。
 *
 * fs / pg の2実装を並べる（pg は PGlite）。**メモリ実装は並べない**——`putApproval` が
 * `pendingApprovalSchema.parse` を書き込み時に通すので、壊れた行を保持できない。
 */

// createdAt が日時の形でない——版ずれ・手編集を模す。
const BAD_APPROVAL_RAW = {
  id: 'ap-bad',
  createdAt: 'not-a-date-from-a-newer-deploy',
  question: '壊れた承認の質問（この文字列は跡にも例外にも出てはいけない）',
};

const GOOD_APPROVAL: PendingApproval = {
  id: 'ap-good',
  createdAt: '2026-09-02T00:00:00.000Z',
  question: '読める承認の質問',
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** 回答の呼びを数えるだけの偽のクローン。読めない行では呼ばれないはず。 */
function fakeCloneHost(stores: Stores): CloneHost & { answered: string[] } {
  const answered: string[] = [];
  return {
    answered,
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval(approvalId: string) {
      answered.push(approvalId);
    },
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
  const clone = fakeCloneHost(stores);
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  return { app, clone };
}

/** 3実装共通の「投げる型・文言・本文を含めない」の検査。 */
function expectUnreadable(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(UnreadableApprovalError);
  const error = thrown as UnreadableApprovalError;
  expect(error.id).toBe(BAD_APPROVAL_RAW.id);
  expect(error.message).toContain(`承認待ち ${BAD_APPROVAL_RAW.id} は在るが読めない`);
  expect(error.message).not.toContain(BAD_APPROVAL_RAW.question);
}

async function catching(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** HTTP の3口（1件の回答・一括回答・トレース）を通して、409 と本文を測る。 */
async function expectHttpSaysUnreadable(stores: Stores): Promise<void> {
  const { app, clone } = appOver(stores);

  const single = await app.request(
    `/approvals/${BAD_APPROVAL_RAW.id}/answer`,
    json({ answer: 'よい' }),
  );
  expect(single.status).toBe(409);
  const singleBody = (await single.json()) as { error: string };
  expect(singleBody.error).toContain(`承認待ち ${BAD_APPROVAL_RAW.id} は在るが読めない`);
  expect(singleBody.error).not.toContain(BAD_APPROVAL_RAW.question);

  // 本当に無い id は従来どおり 404。
  const missing = await app.request('/approvals/ap-nowhere/answer', json({ answer: 'よい' }));
  expect(missing.status).toBe(404);

  // 一括: 読めない1件だけが失敗し、読める件は進む。
  const bulk = await app.request(
    '/approvals/answer',
    json({
      answers: [
        { id: BAD_APPROVAL_RAW.id, answer: 'よい' },
        { id: 'ap-nowhere', answer: 'よい' },
        { id: GOOD_APPROVAL.id, answer: 'よい' },
      ],
    }),
  );
  expect(bulk.status).toBe(200);
  const { results } = (await bulk.json()) as {
    results: { id: string; ok: boolean; error?: string }[];
  };
  expect(results[0]?.ok).toBe(false);
  expect(results[0]?.error).toContain(`承認待ち ${BAD_APPROVAL_RAW.id} は在るが読めない`);
  expect(results[0]?.error).not.toBe('not found');
  expect(results[1]).toEqual({ id: 'ap-nowhere', ok: false, error: 'not found' });
  expect(results[2]).toEqual({ id: GOOD_APPROVAL.id, ok: true });
  // 読めない行の回答は、クローンへ渡っていない。
  expect(clone.answered).toEqual([GOOD_APPROVAL.id]);

  const trace = await app.request(`/approvals/${BAD_APPROVAL_RAW.id}/trace`);
  expect(trace.status).toBe(409);

  // `GET /approvals/:id`（#3312）: 読めない行は「無い」（404）ではなく 409。本当に無い id は 404、読める行は 200。
  const byId = await app.request(`/approvals/${BAD_APPROVAL_RAW.id}`);
  expect(byId.status).toBe(409);
  const byIdBody = (await byId.json()) as { error: string };
  expect(byIdBody.error).toContain(BAD_APPROVAL_RAW.id);
  expect(byIdBody.error).not.toContain(BAD_APPROVAL_RAW.question);
  expect((await app.request('/approvals/ap-nowhere')).status).toBe(404);
  expect((await app.request(`/approvals/${GOOD_APPROVAL.id}`)).status).toBe(200);
}

describe('JobStore.getApproval() / updateApproval() — 読めない承認の行の扱い', () => {
  // PGlite の雛形（WASM の起動＋migrate）は、ワーカーで最初に呼んだ歯が払う。
  // 歯の本体（既定 5000ms）でなく hook（明示 30_000ms）で払わせる（issue #2337）。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  describe('fs 実装', () => {
    async function seed() {
      const root = await makeTempDir('alteroid-test-');
      const dir = join(root, 'jobs');
      const jobsPath = join(dir, 'jobs.json');
      await mkdir(dir, { recursive: true });
      await writeFile(
        jobsPath,
        `${JSON.stringify({ jobs: [], approvals: [BAD_APPROVAL_RAW, GOOD_APPROVAL] }, null, 2)}\n`,
      );
      return { jobsPath, stores: createFsStores(root) };
    }

    it('getApproval() は読めない行で UnreadableApprovalError を投げる。無い id は null、読める行は読める', async () => {
      const { stores } = await seed();
      let thrown: unknown;
      await captureStderr(async () => {
        thrown = await catching(() => stores.jobs.getApproval(BAD_APPROVAL_RAW.id));
      });
      expectUnreadable(thrown);
      await captureStderr(async () => {
        expect(await stores.jobs.getApproval('ap-nowhere')).toBeNull();
        expect(await stores.jobs.getApproval(GOOD_APPROVAL.id)).toEqual(GOOD_APPROVAL);
      });
    });

    it('updateApproval() は読めない行で UnreadableApprovalError を投げる。mutate は呼ばれず、行は1バイトも変わらない', async () => {
      const { jobsPath, stores } = await seed();
      const before = await readFile(jobsPath, 'utf8');
      let called = false;
      let thrown: unknown;
      await captureStderr(async () => {
        thrown = await catching(() =>
          stores.jobs.updateApproval(BAD_APPROVAL_RAW.id, (current) => {
            called = true;
            return current;
          }),
        );
      });
      expectUnreadable(thrown);
      expect(called).toBe(false);
      expect(await readFile(jobsPath, 'utf8')).toBe(before);
    });

    it('updateApproval() は本当に無い id で従来どおり null', async () => {
      const { stores } = await seed();
      let result: PendingApproval | null | undefined;
      await captureStderr(async () => {
        result = await stores.jobs.updateApproval('ap-nowhere', (current) => current);
      });
      expect(result).toBeNull();
    });

    it('HTTP: 回答・一括回答・トレースは読めない行を 404 / not found と言わず 409 で返す', async () => {
      const { jobsPath, stores } = await seed();
      const before = await readFile(jobsPath, 'utf8').then(
        (raw) => JSON.parse(raw) as { approvals: unknown[] },
      );
      await captureStderr(async () => {
        await expectHttpSaysUnreadable(stores);
      });
      // 読めない行は書き換えられていない（残っている）。
      const after = JSON.parse(await readFile(jobsPath, 'utf8')) as { approvals: unknown[] };
      expect(after.approvals).toContainEqual(BAD_APPROVAL_RAW);
      expect(before.approvals).toContainEqual(BAD_APPROVAL_RAW);
    });
  });

  describe('pg 実装', () => {
    let client: PGlite;
    let db: Db;
    let stores: PgStores;

    afterEach(async () => {
      await client.close();
    });

    async function seed() {
      ({ client, db } = await createMigratedPglite());
      stores = createPgStoresFromDb(db);
      await stores.jobs.putApproval(GOOD_APPROVAL);
      // 行を直接 insert する——`putApproval()` は `pendingApprovalSchema.parse` を通す。
      await db.insert(tables.approvals).values({
        id: BAD_APPROVAL_RAW.id,
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
        answeredAt: null,
        withdrawnAt: null,
        approval: BAD_APPROVAL_RAW,
      });
    }

    it('getApproval() は読めない行で UnreadableApprovalError を投げる。無い id は null、読める行は読める', async () => {
      await seed();
      expectUnreadable(await catching(() => stores.jobs.getApproval(BAD_APPROVAL_RAW.id)));
      expect(await stores.jobs.getApproval('ap-nowhere')).toBeNull();
      expect(await stores.jobs.getApproval(GOOD_APPROVAL.id)).toEqual(GOOD_APPROVAL);
    });

    it('updateApproval() は読めない行で UnreadableApprovalError を投げる。mutate は呼ばれず、行は書き換えられない', async () => {
      await seed();
      let called = false;
      const thrown = await catching(() =>
        stores.jobs.updateApproval(BAD_APPROVAL_RAW.id, (current) => {
          called = true;
          return current;
        }),
      );
      expectUnreadable(thrown);
      expect(called).toBe(false);
      const rows = await db.select().from(tables.approvals);
      expect(rows.find((row) => row.id === BAD_APPROVAL_RAW.id)?.approval).toEqual(
        BAD_APPROVAL_RAW,
      );
    });

    it('updateApproval() は本当に無い id で従来どおり null', async () => {
      await seed();
      expect(await stores.jobs.updateApproval('ap-nowhere', (current) => current)).toBeNull();
    });

    it('HTTP: 回答・一括回答・トレースは読めない行を 404 / not found と言わず 409 で返す', async () => {
      await seed();
      await expectHttpSaysUnreadable(stores);
    });
  });
});
