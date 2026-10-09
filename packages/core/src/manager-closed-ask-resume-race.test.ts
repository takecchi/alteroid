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
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
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
      // daemon の境界（`runnerEventSchema.safeParse`）を実際に通す: スキーマに無い欄はここで黙って落ちるので、emit した中身だけを見ていると境界で消えたことに気づけない。
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
    // 既定 3000ms より大きく取る: 実時間の中で窓が自然に閉じると「flush させていない」状態を作れない。
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

describe('終端の closed が、await を挟んで遅れて処理される ask / resume_failed に書き戻されない（#3160 と同じ形）', () => {
  for (const closedStatus of ['failed', 'lost'] as const) {
    it(`ask の直後に closed(${closedStatus}) が続けて届く → 台帳は ${closedStatus} のまま（waiting_human に戻らない）`, async () => {
      const { pool, stores, fake } = await runningManualSetup('mgr-ask');
      fake.raw({
        type: 'ask',
        managerId: 'mgr-ask',
        requestId: 'req-1',
        kind: 'question',
        summary: '確認したい',
      } as RunnerEvent);
      fake.closed('mgr-ask', closedStatus, '畳んだ');
      await settle();
      expect(await jobStatusOf(stores, 'mgr-ask')).toBe(closedStatus);
      await pool.stop();
    });

    it(`resume_failed(recovered=true) の直後に closed(${closedStatus}) が続けて届く → 台帳は ${closedStatus} のまま（running に戻らない）`, async () => {
      const { pool, stores, fake } = await runningManualSetup('mgr-rf');
      fake.resumeFailed('mgr-rf', 'sess-mgr-rf', '戻れなかった', true);
      fake.closed('mgr-rf', closedStatus, '畳んだ');
      await settle();
      expect(await jobStatusOf(stores, 'mgr-rf')).toBe(closedStatus);
      await pool.stop();
    });
  }

  for (const closedStatus of ['failed', 'lost'] as const) {
    it(`closed(${closedStatus}) を処理し終えた後に ask が直列に届いても、台帳は ${closedStatus} のまま（waiting_human に戻らない）`, async () => {
      const { pool, stores, fake } = await runningManualSetup('mgr-ask-after');
      fake.closed('mgr-ask-after', closedStatus, '畳んだ');
      await settle();
      expect(await jobStatusOf(stores, 'mgr-ask-after')).toBe(closedStatus);
      fake.raw({
        type: 'ask',
        managerId: 'mgr-ask-after',
        requestId: 'req-late',
        kind: 'question',
        summary: '遅れた確認',
      } as RunnerEvent);
      await settle();
      expect(await jobStatusOf(stores, 'mgr-ask-after')).toBe(closedStatus);
      await pool.stop();
    });
  }

  it('対照: resume_failed(recovered=true) を処理し終えてから closed(failed) が届けば failed', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-ctl');
    fake.resumeFailed('mgr-ctl', 'sess-mgr-ctl', '戻れなかった', true);
    await settle();
    fake.closed('mgr-ctl', 'failed', '畳んだ');
    await settle();
    expect(await jobStatusOf(stores, 'mgr-ctl')).toBe('failed');
    await pool.stop();
  });
});
