import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
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
import type { TokenRotatorObservation } from './token-rotator.js';

// #4861: failed の担当の後継を立てても前任が鍵の回転で起き上がって二重になる。
// 案A: `supersedes` で前任を引き継ぎ済みにして自動の起こし直しから外す。案B: 自動で起こし直した failed / lost はクローンへ知らせる。

const ID = 'mgr-old';

const JOB: Job = {
  id: ID,
  managerId: ID,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T01:00:00.000Z',
  status: 'running',
  summary: '監査',
  request: '監査して',
  cwd: '/work/project',
  sessionId: 'sess-old',
  runnerId: 'runner-primary',
};

function fakeRunner(initiallyAlive: boolean) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = initiallyAlive
    ? [
        {
          managerId: ID,
          status: 'running',
          cwd: JOB.cwd ?? '',
          request: JOB.request ?? '',
          waiting: [],
          sessionId: 'sess-old',
        },
      ]
    : [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const starts: string[] = [];
  const control: { beforeStart?: () => Promise<void> } = {};
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd?: string }> {
      starts.push(command.managerId);
      await control.beforeStart?.();
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      resumes.push(command);
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return {};
    },
    async send(managerId, text) {
      sends.push({ managerId, text });
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
    sends,
    resumes,
    starts,
    control,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function setup(options: {
  rotateOnObservation: boolean;
  initiallyAlive?: boolean;
  job?: Job;
}) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(options.job ?? JOB);
  const fake = fakeRunner(options.initiallyAlive === true);
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const observations: TokenRotatorObservation[] = [];
  const ref: { pool?: ReturnType<typeof createManagerPool> } = {};
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    synthesizedNoticeWindowMs: 0,
    onUsageObservation: async (observation) => {
      observations.push(observation);
      if (options.rotateOnObservation) await ref.pool?.resumeStoppedByUsage();
    },
  });
  ref.pool = pool;
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return { pool, fake, stores, inbox, observations };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function sessionDiedBy429(): RunnerEvent {
  return {
    type: 'closed',
    managerId: ID,
    status: 'failed',
    reason:
      "マネージャーのセッションが落ちた: You've hit your individual spend limit for this account.",
  } as RunnerEvent;
}

function turnEndedBy429(): RunnerEvent {
  return {
    type: 'report',
    managerId: ID,
    text: '（このターンは応答を返さずに終わった: success/429 / result_is_error）\nAPI Error: 429',
    status: 'done',
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  } as RunnerEvent;
}

function rewokenNotices(inbox: readonly InboxEvent[]): string[] {
  return inbox.flatMap((event) =>
    event.type === 'manager_message' && event.text.includes('新しい鍵で起こし直した')
      ? [event.text]
      : [],
  );
}

describe('後継を立てた前任は、自動で起こし直さない（#4861 案A）', () => {
  it('(a) failed で枠の印が立った前任に supersedes 付きで後継を立てると、鍵の回転と周回の掃きで前任は起き上がらない', async () => {
    const s = await setup({ rotateOnObservation: false });
    s.fake.push(sessionDiedBy429());
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();

    const successor = await s.pool.start({ request: '後継', supersedes: ID });

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    await settle();
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);

    const jobs = await s.stores.jobs.listJobs();
    const old = jobs.find((job) => job.id === ID);
    expect(old?.supersededBy).toBe(successor.managerId);
    expect(old?.usageStoppedAt).toBeUndefined();
    expect(old?.status).toBe('failed');
    expect(jobs.find((job) => job.id === successor.managerId)?.supersedes).toBe(ID);
    expect(successor.supersedes).toBe(ID);
    expect(rewokenNotices(s.inbox)).toEqual([]);

    const entries = await s.stores.journal.list({ limit: 200 });
    expect(
      entries.some(
        (e) =>
          e.type === 'decision' &&
          e.decision.includes(`[${ID}] を後継 [${successor.managerId}] に引き継いだ`) &&
          e.decision.includes('以後は自動で起こさない'),
      ),
    ).toBe(true);
  });

  it('(a) 前任へ預かっていた伝言は、本文ごとクローンへ返される', async () => {
    const s = await setup({
      rotateOnObservation: false,
      job: {
        ...JOB,
        status: 'failed',
        usageStoppedAt: '2026-10-15T01:30:00.000Z',
        heldMessages: [
          { text: '預かりの本文XYZ', heldAt: '2026-10-15T02:00:00.000Z', reason: '試験' },
        ],
      },
    });

    const successor = await s.pool.start({ request: '後継', supersedes: ID });
    await settle();

    expect(
      s.inbox.some(
        (event) =>
          event.type === 'manager_message' &&
          event.text.includes('預かりの本文XYZ') &&
          event.text.includes(`後継 ${successor.managerId} に引き継いだ`),
      ),
    ).toBe(true);
    expect((await s.stores.jobs.listJobs()).find((j) => j.id === ID)?.heldMessages).toBeUndefined();
  });

  it('(b) 前任が running なら supersedes は断られ、後継は起きない', async () => {
    const s = await setup({ rotateOnObservation: false, initiallyAlive: true });

    await expect(s.pool.start({ request: '後継', supersedes: ID })).rejects.toThrow('manager_stop');

    expect(s.fake.starts).toHaveLength(0);
    expect((await s.pool.list()).map((m) => m.managerId)).toEqual([ID]);
    expect((await s.stores.jobs.listJobs()).find((j) => j.id === ID)?.supersededBy).toBeUndefined();
  });

  it('(b) 前任が台帳に無いときも断られ、後継は起きない', async () => {
    const s = await setup({ rotateOnObservation: false });

    await expect(s.pool.start({ request: '後継', supersedes: 'mgr-nothing' })).rejects.toThrow(
      '台帳に無い',
    );
    expect(s.fake.starts).toHaveLength(0);
  });
});

describe('引き継ぎ中の前任に印を立てる（#4865）', () => {
  async function failedByUsage() {
    const s = await setup({ rotateOnObservation: false });
    s.fake.push(sessionDiedBy429());
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
    return s;
  }

  it('(e) 後継の runner 起動を待っている間に鍵の回転が起きても、前任は起こされない', async () => {
    const s = await failedByUsage();
    let release: () => void = () => undefined;
    s.fake.control.beforeStart = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const starting = s.pool.start({ request: '後継', supersedes: ID });
    await settle();
    expect(s.fake.starts).toHaveLength(1);

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);

    release();
    const successor = await starting;
    expect((await s.stores.jobs.listJobs()).find((j) => j.id === ID)?.supersededBy).toBe(
      successor.managerId,
    );
  });

  it('(f) 同じ前任を指す start を並行させると片方が断られ、後継は1本だけ立つ', async () => {
    const s = await failedByUsage();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.fake.control.beforeStart = () => gate;

    const first = s.pool.start({ request: '後継1', supersedes: ID });
    const second = s.pool.start({ request: '後継2', supersedes: ID });
    const results = Promise.allSettled([first, second]);
    await settle();
    release();
    const [a, b] = await results;

    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = [a, b].find((r) => r.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toContain('引き継ぎ中の後継');
    expect(s.fake.starts).toHaveLength(1);
    const jobs = await s.stores.jobs.listJobs();
    expect(jobs.filter((j) => j.supersedes === ID)).toHaveLength(1);
  });

  it('(g) 後継の起動が失敗したら印が下り、その後の鍵の回転で前任は従来どおり起こされる', async () => {
    const s = await failedByUsage();
    s.fake.control.beforeStart = async () => {
      throw new Error('起動に失敗');
    };

    await expect(s.pool.start({ request: '後継', supersedes: ID })).rejects.toThrow('起動に失敗');
    s.fake.control.beforeStart = undefined;

    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    await settle();
    expect(s.fake.resumes.map((c) => c.managerId)).toEqual([ID]);
    expect((await s.stores.jobs.listJobs()).find((j) => j.id === ID)?.supersededBy).toBeUndefined();
  });
});

describe('自動の起こし直しをクローンへ知らせる（#4861 案B）', () => {
  it('(c) supersedes の無い後継では今どおり前任が起き上がり、受信箱へ「起こし直した」の知らせが積まれる', async () => {
    const s = await setup({ rotateOnObservation: false });
    s.fake.push(sessionDiedBy429());
    await settle();
    await s.pool.start({ request: '後継（supersedes なし）' });

    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    await settle();

    expect(s.fake.resumes.map((c) => c.managerId)).toEqual([ID]);
    const notices = rewokenNotices(s.inbox);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      `[${ID}] を新しい鍵で起こし直した（枠で落ちていた。status=failed）`,
    );
    expect(notices[0]).toContain('manager_stop');
    expect(notices[0]).toContain('supersedes');
  });

  it('(d) done の担当に続きを促しただけのときは、知らせを積まない', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push(turnEndedBy429());
    await settle();

    expect(s.fake.sends).toHaveLength(1);
    expect(rewokenNotices(s.inbox)).toEqual([]);
  });
});
