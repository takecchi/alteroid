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
 * **Issue #3161 — `lost` に確定した後に届いた `closed` が、台帳の `lost` を上書きしない。**
 *
 * `lost` のまま日誌に残す（`stopped` の後と同じ扱い）。ただし `closed(done)` だけは、
 * 「成果が出ている可能性がある」ので、クローンの受信箱へ1回だけ `report` で知らせる。
 * `closed(failed)` / `closed(lost)` は日誌だけ。
 *
 * 足場（`manualRunner` / `runningManualSetup` / `createMemoryStores`）は
 * `manager-closed-failed-system-error.test.ts` と同じものをこの歯専用に複製してある
 * （duplicated on purpose——同ファイルの doc と同じ理由）。
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

function lateDoneNotices(inbox: InboxEvent[], id: string): InboxEvent[] {
  return inbox.filter(
    (e) =>
      e.type === 'manager_message' && e.managerId === id && e.text.includes('後から runner が'),
  );
}

describe('lost の後に届いた closed が lost を上書きしない', () => {
  it('lost の後に closed(done) が来ても status は lost のまま', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-2');
    fake.closed('mgr-2', 'lost', '消えた');
    await settle();
    expect(await jobStatusOf(stores, 'mgr-2')).toBe('lost');
    fake.closed('mgr-2', 'done', '遅れて来た完了');
    await settle();
    expect(await jobStatusOf(stores, 'mgr-2')).toBe('lost');
    await pool.stop();
  });

  it('lost の後の closed(done) は、受信箱へ「done が届いた」知らせを1回出す', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-3');
    fake.closed('mgr-3', 'lost', '消えた');
    await settle();
    expect(lateDoneNotices(inbox, 'mgr-3')).toHaveLength(0);
    fake.closed('mgr-3', 'done', '遅れて来た完了');
    await settle();
    const notices = lateDoneNotices(inbox, 'mgr-3');
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    if (notice?.type !== 'manager_message') throw new Error('manager_message ではない');
    expect(notice.kind).toBe('report');
    expect(notice.text).toContain('mgr-3');
    expect(notice.text).toContain('lost');
    expect(notice.text).toContain('確かめること');
    expect(notice.text).toContain('遅れて来た完了');
    await pool.stop();
  });

  it('closed(done) を2回送っても知らせは1回で、印は台帳に残る（再起動をまたぐ二重の歯）', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-4');
    fake.closed('mgr-4', 'lost', '消えた');
    await settle();
    fake.closed('mgr-4', 'done', '1回目');
    await settle();
    // 1周目が作った副作用（台帳の印）が2周目の入力になる。
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-4');
    expect(job?.lateDoneNotifiedAt).toBeDefined();
    fake.closed('mgr-4', 'done', '2回目');
    await settle();
    expect(lateDoneNotices(inbox, 'mgr-4')).toHaveLength(1);
    expect(await jobStatusOf(stores, 'mgr-4')).toBe('lost');
    await pool.stop();
  });

  it.each(['failed', 'lost'] as const)(
    'lost の後の closed(%s) では受信箱に何も出ず、status も動かない',
    async (late) => {
      const { pool, stores, inbox, fake } = await runningManualSetup('mgr-5');
      fake.closed('mgr-5', 'lost', '消えた');
      await settle();
      const before = inbox.length;
      fake.closed('mgr-5', late, '遅れて来た');
      await settle();
      expect(inbox.slice(before)).toEqual([]);
      expect(await jobStatusOf(stores, 'mgr-5')).toBe('lost');
      await pool.stop();
    },
  );
});
