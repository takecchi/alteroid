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

// #4850 直し方2: 429 で終わった（failed に畳まれた）担当を、枠で止まったものとして扱い、新しい鍵で同じ sessionId から起こし直す。
// 枠の通知（`usage_notice`）が先に届かない道だけを通す: 届く道は manager-usage-resume.test.ts が固定している。

const ID = 'mgr-429';

const JOB: Job = {
  id: ID,
  managerId: ID,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T01:00:00.000Z',
  status: 'running',
  summary: '監査',
  request: '監査して',
  cwd: '/work/project',
  sessionId: 'sess-429',
  runnerId: 'runner-primary',
};

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
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
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function setup(options: { rotateOnObservation: boolean }) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const observations: TokenRotatorObservation[] = [];
  const ref: { pool?: ReturnType<typeof createManagerPool> } = {};
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    // 回し手の代役: 使える鍵があれば回して、鍵が戻ったと本番と同じ口（`resumeStoppedByUsage`）で言う。
    onUsageObservation: async (observation) => {
      observations.push(observation);
      if (options.rotateOnObservation) await ref.pool?.resumeStoppedByUsage();
    },
  });
  ref.pool = pool;
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return { pool, fake, stores, observations, inbox };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 枠の文言は本文に無い（構造化された 429 だけが枠の証拠）。
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

function sessionDiedBy429(): RunnerEvent {
  return {
    type: 'closed',
    managerId: ID,
    status: 'failed',
    reason:
      "マネージャーのセッションが落ちた: You've hit your individual spend limit for this account.",
  } as RunnerEvent;
}

describe('429 で終わった担当を、枠で止まったものとして起こし直す（#4850）', () => {
  it('(a) セッションごと 429 で failed に畳まれた担当は印が立ち、使える鍵が在ればすぐ同じ sessionId から起こし直される', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push(sessionDiedBy429());
    await settle();

    expect(s.observations.map((o) => o.notice?.kind)).toEqual(['reached']);
    expect(s.fake.resumes.map((c) => [c.managerId, c.sessionId])).toEqual([[ID, 'sess-429']]);
    expect(s.fake.resumes[0]?.message).toContain('通る鍵に戻った');
    // 起こせたので印は下りる
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    const entries = await s.stores.journal.list({ limit: 200 });
    expect(
      entries.some(
        (e) => e.type === 'exchange' && e.text.includes('起こし直した') && e.text.includes(ID),
      ),
    ).toBe(true);
  });

  it('(a) 使える鍵が無い間は印が台帳に残り、鍵が戻った時点で起こし直される', async () => {
    const s = await setup({ rotateOnObservation: false });

    s.fake.push(sessionDiedBy429());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect(s.fake.resumes.map((c) => c.sessionId)).toEqual(['sess-429']);
  });

  it('(a) 失敗の分類（status=429）が枠なら、本文に枠の文言が無いターンも印が立ち、鍵が戻れば続きを促される', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push(turnEndedBy429());
    await settle();

    expect(s.observations.map((o) => o.notice?.kind)).toEqual(['reached']);
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
  });

  it('⭐ セッションごと落ちた理由文が API の 429（rate_limit_error）なら、枠の決まり文句が無くても印が立ち、起こし直される（#4859）', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push({
      type: 'closed',
      managerId: ID,
      status: 'failed',
      reason:
        'マネージャーのセッションが落ちた: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization."}}',
    } as RunnerEvent);
    await settle();

    expect(s.observations.map((o) => o.notice?.kind)).toEqual(['reached']);
    expect(s.fake.resumes.map((c) => [c.managerId, c.sessionId])).toEqual([[ID, 'sess-429']]);
  });

  it('対照: 理由文が API の 500 なら、今どおり印を立てない（#4859）', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push({
      type: 'closed',
      managerId: ID,
      status: 'failed',
      reason:
        'マネージャーのセッションが落ちた: API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    } as RunnerEvent);
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    expect(s.observations).toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
  });

  it('(b) 枠と無関係な失敗（クラッシュ・500）は印を立てず、起こし直さない', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push({
      type: 'closed',
      managerId: ID,
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: Error: spawn EAGAIN',
    } as RunnerEvent);
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    expect(s.observations).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
  });

  it('(b) 枠と無関係な失敗のターン（500）は、report に failure が付いても印を立てない', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push({
      type: 'report',
      managerId: ID,
      text: '（このターンは応答を返さずに終わった: success/500 / result_is_error）\nAPI Error: 500',
      status: 'done',
      failure: { code: 'success/500', via: 'result_is_error', status: 500 },
      synthesized: 'turn_failed',
    } as RunnerEvent);
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    expect(s.observations).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
  });

  // runner は resume が戻れないとき、`resume_failed(recovered:false)` を出してから同じ理由文で `closed(lost)` を出す（runner-resume-recovery.ts / runner.ts）。
  const REASON_429 =
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization."}}';
  const REASON_OTHER = 'Error: No conversation found with session ID: sess-429';
  function resumeFailed(reason: string): RunnerEvent {
    return {
      type: 'resume_failed',
      managerId: ID,
      sessionId: 'sess-429',
      reason,
      recovered: false,
    } as RunnerEvent;
  }
  function lostBy(reason: string): RunnerEvent {
    return { type: 'closed', managerId: ID, status: 'lost', reason } as RunnerEvent;
  }

  it('⭐ resume が 429 で戻れず lost で閉じた担当は、resume_failed → closed(lost) の順で流れても印が残り、鍵の回転で起こし直され、成功したら印が下りる（#4866）', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push(resumeFailed(REASON_429));
    s.fake.push(lostBy(REASON_429));
    await settle();

    expect(s.observations.map((o) => o.notice?.kind)).toEqual(['reached']);
    expect(s.fake.resumes.map((c) => [c.managerId, c.sessionId])).toEqual([[ID, 'sess-429']]);
    const job = (await s.stores.jobs.listJobs())[0];
    expect(job?.status).toBe('running');
    expect(job?.usageStoppedAt).toBeUndefined();
  });

  it('(#4866) 鍵が無い間は lost の印が台帳に残り、鍵が戻った時点で起こし直される', async () => {
    const s = await setup({ rotateOnObservation: false });

    s.fake.push(resumeFailed(REASON_429));
    s.fake.push(lostBy(REASON_429));
    await settle();

    const lost = (await s.stores.jobs.listJobs())[0];
    expect(lost?.status).toBe('lost');
    expect(lost?.usageStoppedAt).toBeDefined();
    expect(s.fake.resumes).toHaveLength(0);

    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect(s.fake.resumes.map((c) => c.sessionId)).toEqual(['sess-429']);
  });

  it('(#4866) 対照: 枠と無関係な理由の resume 失敗（lost）には印を立てず、起こし直さない', async () => {
    const s = await setup({ rotateOnObservation: true });

    s.fake.push(resumeFailed(REASON_OTHER));
    s.fake.push(lostBy(REASON_OTHER));
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    expect(s.observations).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
    const job = (await s.stores.jobs.listJobs())[0];
    expect(job?.status).toBe('lost');
    expect(job?.usageStoppedAt).toBeUndefined();
  });

  it('(#4866) lost の知らせは枠の印の有無で増えず、失敗の知らせ（closed_failed）も足さない', async () => {
    const s = await setup({ rotateOnObservation: false });
    s.fake.push(resumeFailed(REASON_429));
    s.fake.push(lostBy(REASON_429));
    await settle();

    const t = await setup({ rotateOnObservation: false });
    t.fake.push(resumeFailed(REASON_OTHER));
    t.fake.push(lostBy(REASON_OTHER));
    await settle();

    expect(s.inbox.length).toBe(t.inbox.length);
    expect(s.inbox.filter((e) => JSON.stringify(e).includes('セッションが落ちた'))).toEqual([]);
  });

  it('(c) manager_stop で止めた委譲は、429 の印が立っていても起こし直さない', async () => {
    const s = await setup({ rotateOnObservation: false });
    s.fake.push(sessionDiedBy429());
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();

    await s.pool.abort(ID);
    s.fake.resumes.length = 0;
    s.fake.sends.length = 0;

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.status).toBe('stopped');
  });
});
