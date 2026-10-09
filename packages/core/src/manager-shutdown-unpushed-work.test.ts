import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  setUnpushedWorkResult(result: UnpushedWorkResult): void;
  shutdownUnpushedWork(
    managerId: string,
    unpushedWork:
      { kind: 'ok'; result: UnpushedWorkResult } | { kind: 'unavailable'; reason: string },
  ): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  let unpushedWorkResult: UnpushedWorkResult | undefined;

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
      /* 使わない */
    },
    async unpushedWork() {
      return unpushedWorkResult;
    },
  };

  function send(raw: RunnerEvent): void {
    // 境界のスキーマを通す: 無い欄は黙って落ちるので、emit した中身だけでは消えたことに気づけない。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  }

  return {
    runner,
    alive,
    setUnpushedWorkResult(result) {
      unpushedWorkResult = result;
    },
    shutdownUnpushedWork(managerId, unpushedWork) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      send({ type: 'shutdown_unpushed_work', managerId, unpushedWork });
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
  managerId = 'mgr-quota',
  now?: () => number,
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
    ...(now === undefined ? {} : { now }),
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function listedOf(pool: ManagerPool, managerId: string) {
  const all = await pool.list();
  const found = all.find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

describe('台帳の lastUnpushedWorkObservation が、shutdown_unpushed_work（Issue #1266 候補(C)）でも残る', () => {
  it('1. observed: shutdown_unpushed_work の unpushedWork（kind:ok）が、台帳に kind:observed として残る。status には触れない', async () => {
    const { pool, fake } = await runningManualSetup('mgr-observed');

    fake.shutdownUnpushedWork('mgr-observed', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/1266-shutdown-observation' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-observed');
    expect(listed.status).toBe('running');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1266-shutdown-observation' }],
    });

    await pool.stop();
  });

  it('1b. 件数（unpushedCommitCount 等）も台帳へ写る——器の入れ替え後の案内が失われた件数を言うため（Issue #2751）', async () => {
    const { pool, fake } = await runningManualSetup('mgr-counts');

    fake.shutdownUnpushedWork('mgr-counts', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [
          {
            relativePath: '.',
            branch: 'feat/x',
            unpushedCommitCount: 3,
            uncommittedChangeCount: 2,
          },
          {
            relativePath: 'sub',
            branch: 'feat/y',
            unpushedCommitCountUnknown: 'git が落ちた',
            uncommittedChangeCountUnknown: '読めなかった',
          },
        ],
      },
    });
    await vi.waitFor(async () => {
      expect((await listedOf(pool, 'mgr-counts')).lastUnpushedWorkObservation?.kind).toBe(
        'observed',
      );
    });

    const listed = await listedOf(pool, 'mgr-counts');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      worktrees: [
        { relativePath: '.', unpushedCommitCount: 3, uncommittedChangeCount: 2 },
        {
          relativePath: 'sub',
          unpushedCommitCountUnknown: 'git が落ちた',
          uncommittedChangeCountUnknown: '読めなかった',
        },
      ],
    });

    await pool.stop();
  });

  it('2. unavailable: shutdown_unpushed_work の unpushedWork（kind:unavailable）が、台帳に kind:unavailable + reason として残る', async () => {
    const { pool, fake } = await runningManualSetup('mgr-unavailable');

    fake.shutdownUnpushedWork('mgr-unavailable', {
      kind: 'unavailable',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-unavailable');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'unavailable',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    });

    await pool.stop();
  });

  it('3. 上書きガード: 既に新しい観測が乗っているとき、shutdown_unpushed_work が運ぶ古い観測では上書きしない', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-guard', () => clock);

    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/newer-observation' }],
    });
    await pool.unpushedWork('mgr-guard');

    const beforeShutdown = await listedOf(pool, 'mgr-guard');
    expect(beforeShutdown.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });

    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.shutdownUnpushedWork('mgr-guard', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/stale-race' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterShutdown = await listedOf(pool, 'mgr-guard');
    expect(afterShutdown.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });

    await pool.stop();
  });

  it('4.（対照）shutdown_unpushed_work の観測のほうが新しいときは、ちゃんと上書きする', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-fresh', () => clock);

    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/older-observation' }],
    });
    await pool.unpushedWork('mgr-fresh');

    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    fake.shutdownUnpushedWork('mgr-fresh', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/newest-observation' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = await listedOf(pool, 'mgr-fresh');
    expect(after.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newest-observation' }],
    });

    await pool.stop();
  });

  it('5. 届かなかった回: shutdown_unpushed_work を一度も送らなければ、欄は undefined のまま——0件を作らない', async () => {
    const { pool } = await runningManualSetup('mgr-never-arrived');

    const listed = await listedOf(pool, 'mgr-never-arrived');
    // unavailable にも化けさせない: 「取れなかった」と「届いていない」が区別できなくなる。
    expect(listed.lastUnpushedWorkObservation).toBeUndefined();

    await pool.stop();
  });
});
