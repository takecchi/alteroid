import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **Issue #3160 — 直前に届いた `report` の処理が、後から届いた終端の
 * `closed(failed / lost)` を `running` / `done` に書き戻す競走を撃つ。**
 *
 * runner の出来事は `void this.#onEvent(...)` で並行に処理される。`case 'report'` は
 * `await` の後に `record.job.status = event.status` を書くので、その間に `closed` が
 * 終端を書いていると上書きしてしまう。直し方は、書く直前に読み直して `failed` /
 * `lost` なら status を動かさないこと（`done` は idle も兼ねるので対象外）。
 *
 * 足場（`manualRunner` / `runningManualSetup`）は `manager-closed-failed-journal.test.ts`
 * 系と同じものをこの歯専用に複製してある。実時間の待ちは使わない
 * （`scripts/wallclock-waits-ratchet.test.ts`、#2146）。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  raw(event: RunnerEvent): void;
  resumeFailed(managerId: string, sessionId: string, reason: string, recovered: boolean): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async send() {
      /* この検証では使わない */
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    alive,
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      // **daemon の境界（runnerEventSchema.safeParse）を実際に通す**
      // （`manager-closed-failed-system-error.test.ts` と同じ作法——スキーマに
      // 無い欄はここで黙って落ちるので、emit した中身だけを見ていると境界で
      // 消えたことに気づけない）。
      const raw: RunnerEvent = { type: 'closed', managerId, status, reason };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
    raw(event) {
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
    resumeFailed(managerId, sessionId, reason, recovered) {
      const raw: RunnerEvent = {
        type: 'resume_failed',
        managerId,
        sessionId,
        reason,
        recovered,
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId: string,
  options: { synthesizedNoticeWindowMs?: number } = {},
): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    // **既定 3000ms より大きく取る。** テストの実時間の中で窓が自然に閉じて
    // しまうと「flush させていない」状態を作れない——この歯が測りたいのは
    // 「flush 前でも本文が残る」ことなので、窓を意図して開けたままにする。
    synthesizedNoticeWindowMs: options.synthesizedNoticeWindowMs ?? 60_000,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

function jobStatusOf(stores: Stores, id: string): Promise<string | undefined> {
  return stores.jobs.listJobs().then((jobs) => jobs.find((j) => j.id === id)?.status);
}

describe('終端の closed が、直前に届いた report に上書きされない', () => {
  // runner の SSE は `void this.#onEvent(event)` で並行に処理される。report を処理している
  // 途中で closed が来ると、closed が書いた終端を report が後から `event.status` で書き戻す。
  for (const [reportStatus, closedStatus] of [
    ['running', 'failed'],
    ['running', 'lost'],
    ['done', 'failed'],
    ['done', 'lost'],
  ] as const) {
    it(`report(${reportStatus}) の直後に closed(${closedStatus}) が続けて届く → 台帳は ${closedStatus}`, async () => {
      const { pool, stores, fake } = await runningManualSetup('mgr-q');
      fake.raw({
        type: 'report',
        managerId: 'mgr-q',
        status: reportStatus,
        text: '本文',
        reportId: 'r1',
      } as RunnerEvent);
      fake.closed('mgr-q', closedStatus, '畳んだ');
      await settle();
      expect(await jobStatusOf(stores, 'mgr-q')).toBe(closedStatus);
      await pool.stop();
    });
  }

  it('対照: report を処理し終えてから closed(failed) が届けば failed になる', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-c');
    fake.raw({
      type: 'report',
      managerId: 'mgr-c',
      status: 'done',
      text: '本文',
      reportId: 'r1',
    } as RunnerEvent);
    await settle();
    fake.closed('mgr-c', 'failed', '畳んだ');
    await settle();
    expect(await jobStatusOf(stores, 'mgr-c')).toBe('failed');
    await pool.stop();
  });

  // 並行ではなく直列に届いた場合（closed を処理し終えた後に report が届く）。
  for (const [reportStatus, closedStatus] of [
    ['running', 'failed'],
    ['done', 'failed'],
    ['running', 'lost'],
    ['done', 'lost'],
  ] as const) {
    it(`closed(${closedStatus}) を処理し終えた後に report(${reportStatus}) が届いても status を戻さない（本文は残る）`, async () => {
      const { pool, stores, fake } = await runningManualSetup('mgr-s');
      fake.closed('mgr-s', closedStatus, '畳んだ');
      await settle();
      expect(await jobStatusOf(stores, 'mgr-s')).toBe(closedStatus);
      fake.raw({
        type: 'report',
        managerId: 'mgr-s',
        status: reportStatus,
        text: '遅れて届いた本文',
        reportId: 'r-late',
      } as RunnerEvent);
      await settle();
      expect(await jobStatusOf(stores, 'mgr-s')).toBe(closedStatus);
      const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-s');
      expect(job?.lastReport).toBe('遅れて届いた本文');
      await pool.stop();
    });
  }
});
