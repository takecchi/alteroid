import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPoolOptions } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 作業者の落ちで手を止めた担当の印（`#workerLimitStopped`）が、デーモンの再起動を跨いで残る（`#usageStopped` と同じ扱い）。
// 印がメモリだけだと、回転前の鍵で落ちて `done` で止まった担当が、再起動の後は鍵が回っても起こされず放置される。

const JOB: Job = {
  id: 'mgr-wl-restart',
  managerId: 'mgr-wl-restart',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const NUDGE_TEXT =
  '[system] 作業者が上限で落ちた鍵は回った（いまの現役は世代 279）。' +
  'この会話はそのまま続いている（最初からやり直さないこと）。' +
  '作業者を立て直して、止まっていた続きを進めてよい。';

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const delivered: string[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd: string }> {
      alive.push({
        liveBackgroundTasks: 0,
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
      return { cwd: command.cwd };
    },
    async resume(command: RunnerResumeCommand): Promise<{ cwd: string }> {
      delivered.push(command.message ?? '');
      alive.push({
        liveBackgroundTasks: 0,
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return { cwd: command.cwd };
    },
    async send(_managerId, text) {
      delivered.push(text);
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return alive.map((state) => ({ ...state, waiting: [] }));
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    delivered,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 実時計が同じミリ秒に当たって `turnStartedAt` が変わらない揺れを避ける（`manager-worker-limit-wake.test.ts` と同じ）
function strictlyIncreasingNow(): () => number {
  let last = 0;
  return () => {
    last = Math.max(Date.now(), last + 1);
    return last;
  };
}

type Stores = ReturnType<typeof createMemoryStores>;

// 同じ store で Pool を作る。2度目（再起動）の runner は、止まった担当のセッションを持たない（`done` の担当は生きていない）
async function open(stores: Stores, availability: ManagerPoolOptions['tokenAvailability']) {
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ tokenId: 'tok-279', generation: 279 }),
    tokenAvailability: availability,
    now: strictlyIncreasingNow(),
  });
  await pool.restore();
  fake.delivered.length = 0;
  return { pool, fake, stores, inbox };
}

function workerLimitNote(preRotationKey: boolean): RunnerEvent {
  return {
    type: 'note',
    managerId: JOB.id,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    workerLimit: { raw: "You've hit your weekly limit", preRotationKey },
  } as RunnerEvent;
}

function doneReport(): RunnerEvent {
  return { type: 'report', managerId: JOB.id, text: '終わった', status: 'done' } as RunnerEvent;
}

describe('作業者の落ちの印は、デーモンの再起動を跨いで残る', () => {
  it('⭐ 現役の鍵で落ちて done で止まった担当は、再起動の後の resumeStoppedByUsage（鍵の回転）で起こす', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(JOB);
    const before = await open(stores, async () => 'ready');
    before.fake.push(workerLimitNote(false));
    before.fake.push(doneReport());
    await settle();
    expect(before.fake.delivered).toEqual([]);
    expect((await stores.jobs.listJobs())[0]?.status).toBe('done');
    await before.pool.stop();

    // デーモンの再起動: 同じ store で Pool を作り直す
    const after = await open(stores, async () => 'ready');
    const nudged = await after.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([JOB.id]);
    expect(after.fake.delivered).toEqual([NUDGE_TEXT]);
    await after.pool.stop();
  });

  it('⭐ 回転前の鍵で落ちてターンの終わりに現役が ready でなかった担当は、再起動の後に ready になったら周回の掃きで起こす', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(JOB);
    const before = await open(stores, async () => 'cooling');
    before.fake.push(workerLimitNote(true));
    before.fake.push(doneReport());
    await settle();
    expect(before.fake.delivered).toEqual([]);
    await before.pool.stop();

    const after = await open(stores, async () => 'ready');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60 * 1000 });
    try {
      expect(await after.pool.settleStalledUsageWakes()).toEqual([JOB.id]);
    } finally {
      vi.useRealTimers();
    }
    expect(after.fake.delivered).toEqual([NUDGE_TEXT]);
    await after.pool.stop();
  });
});
