import { describe, expect, it } from 'vitest';

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

// 使用量の起こし直しの本体（`#nudgeForUsageRotation` の合流・`#wakeStoppedByUsage` / `#wakeForWorkerLimit` の印の戻し方）を、
// 別のクラスへ切り出しても崩さないための縛り（`manager-usage-wake-guards` の続き）。
// 公開の口（ManagerPool のメソッドと偽の runner・store）だけで書く。Pool の非公開の欄は読まない。

const ID = 'mgr-usage-core';

const JOB: Job = {
  id: ID,
  managerId: ID,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-core',
  runnerId: 'runner-primary',
};

const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 30, 3am (UTC)";
const JOINED_DECISION = '枠の起こし直しが既に走っているので、重ねて起こさない';

type Availability = 'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined;

function fakeRunner(log: string[]) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const resumes: RunnerResumeCommand[] = [];
  // `resumeGate`: 起こし直し（resume）を、外から開けるまで返さない（1本目が走っている間に2本目の契機を流すため）
  const control = {
    failDelivery: false,
    resumeGate: undefined as Promise<void> | undefined,
  };
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      log.push(`resume:${command.message ?? ''}`);
      resumes.push(command);
      if (control.resumeGate !== undefined) await control.resumeGate;
      if (control.failDelivery) throw new Error('この検証が仕込んだ resume の失敗');
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
      log.push(`send:${text}`);
      return !control.failDelivery;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      if (control.failDelivery) return [];
      return alive.map((state) => ({ ...state, waiting: [], liveBackgroundTasks: 0 }));
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
    resumes,
    control,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setup(
  options: {
    availability?: ManagerPoolOptions['tokenAvailability'];
  } = {},
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const log: string[] = [];
  const fake = fakeRunner(log);
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const clock = { now: Date.parse('2026-10-26T00:00:00.000Z') };
  const key = { generation: 1, availability: 'ready' as Availability };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => {
      // 呼ぶたびに必ず進める: 担当が「新しいターンを始めたか」は開始時刻の文字列の差で見ている
      clock.now += 1;
      return clock.now;
    },
    tokenIdentity: () => ({ tokenId: 'tok-a', generation: key.generation }),
    tokenAvailability: options.availability ?? (async () => key.availability),
    onUsageObservation: async (observation) => {
      log.push(`observation:${observation.notice?.kind ?? 'none'}`);
    },
  });
  await pool.restore();
  fake.resumes.length = 0;
  log.length = 0;
  return { pool, fake, stores, inbox, clock, key, log };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function workerLimitNote(preRotationKey: boolean): RunnerEvent {
  return {
    type: 'note',
    managerId: ID,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    workerLimit: { raw: "You've hit your weekly limit", preRotationKey },
  } as RunnerEvent;
}

function closedBy429(): RunnerEvent {
  return {
    type: 'closed',
    managerId: ID,
    status: 'failed',
    reason: `マネージャーのセッションが落ちた: ${LIMIT_TEXT}`,
  } as RunnerEvent;
}

function doneReport(): RunnerEvent {
  return { type: 'report', managerId: ID, text: '終わった', status: 'done' } as RunnerEvent;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function decisionTexts(s: Setup, needle: string): Promise<string[]> {
  return (await s.stores.journal.list({ types: ['decision'] }))
    .map((entry) => JSON.stringify(entry))
    .filter((text) => text.includes(needle));
}

async function firstJob(s: Setup): Promise<Job | undefined> {
  return (await s.stores.jobs.listJobs())[0];
}

// 鍵が通らない間に枠で failed になった担当（印が立ち、起こされていない）を用意する
async function stoppedByQuota(s: Setup): Promise<void> {
  s.key.availability = 'cooling';
  s.fake.push(closedBy429());
  await settle();
  const job = await firstJob(s);
  expect(job?.status).toBe('failed');
  expect(job?.usageStoppedAt).toBeDefined();
  expect(s.fake.resumes).toHaveLength(0);
  s.key.availability = 'ready';
}

describe('作業者の落ちの起こし直し（#5030）は、起こす前に印を下ろし、届かなかったときだけ戻す', () => {
  it('⭐ 届かなかった（skipped）回は印を台帳ごと戻し、次の回転で起こす', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    s.fake.push(doneReport());
    await settle();
    expect((await firstJob(s))?.workerLimitStopped).toBeDefined();
    s.fake.control.failDelivery = true;

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
    // 起こす前に下ろした印が、届かなかったので戻っている（メモリだけでなく台帳にも）
    expect((await firstJob(s))?.workerLimitStopped).toEqual(
      expect.objectContaining({ preRotationKey: false }),
    );

    s.fake.control.failDelivery = false;
    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect((await firstJob(s))?.workerLimitStopped).toBeUndefined();
    await s.pool.stop();
  });

  it('⭐ 届かない間に別の印へ置き換わっていたら、古い印で上書きして戻さない', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    s.fake.push(doneReport());
    await settle();
    const gate = deferred();
    s.fake.control.failDelivery = true;
    s.fake.control.resumeGate = gate.promise;

    const wake = s.pool.resumeStoppedByUsage();
    await settle();
    expect(s.fake.resumes).toHaveLength(1);
    // 起こし直しの途中で、別の落ちの印（回転前の鍵）が立つ
    s.fake.push(workerLimitNote(true));
    await settle();
    gate.release();

    expect(await wake).toEqual([]);
    expect((await firstJob(s))?.workerLimitStopped).toEqual(
      expect.objectContaining({ preRotationKey: true }),
    );
    await s.pool.stop();
  });
});

describe('枠の起こし直しの合流（#5205）は、印に触らない', () => {
  it('⭐ 走っている1本目が届かなかった（skipped）回に重なった2本目は、印を下ろさない。印は次の回転で拾われる', async () => {
    const s = await setup();
    await stoppedByQuota(s);
    const gate = deferred();
    s.fake.control.failDelivery = true;
    s.fake.control.resumeGate = gate.promise;

    const first = s.pool.resumeStoppedByUsage();
    await settle();
    expect(s.fake.resumes).toHaveLength(1);
    // 1本目が resume の途中で止まっている間に、2本目が来る
    const second = s.pool.resumeStoppedByUsage();
    await settle();
    gate.release();

    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
    expect(await decisionTexts(s, JOINED_DECISION)).toHaveLength(1);
    // 届かなかった1本目の印は残る。2本目が「終わったから」と下ろしてはならない
    expect((await firstJob(s))?.usageStoppedAt).toBeDefined();

    s.fake.control.failDelivery = false;
    s.fake.control.resumeGate = undefined;
    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect((await firstJob(s))?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });
});
