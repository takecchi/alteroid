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

// 抱えていた鍵が回転で古くなった後に枠へ当たった担当は、回転の出来事を待たずに起こし直す（#4980）

const JOB: Job = {
  id: 'mgr-stale-fail',
  managerId: 'mgr-stale-fail',
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 20, 3am (UTC)";

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const stops: string[] = [];
  const behavior: { background: number } = { background: 0 };

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd?: string }> {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
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
      stops.push(managerId);
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return alive.map((state) => ({
        ...state,
        waiting: [],
        liveBackgroundTasks: behavior.background,
      }));
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
    stops,
    behavior,
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

// 世代 278 の鍵で起動した担当を用意する。`status` が done のときは背景処理 1 本を残した done で止める。
async function setup(
  options: {
    done: boolean;
    // 現役の鍵が通るかの答え（tokenId ごと）。既定は新しい鍵だけ ready
    availability?: ManagerPoolOptions['tokenAvailability'];
  } = { done: true },
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  let identity: { tokenId: string; generation: number } | undefined = {
    tokenId: 'tok-278',
    generation: 278,
  };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => (identity === undefined ? undefined : { ...identity }),
    tokenAvailability:
      options.availability ?? (async (tokenId) => (tokenId === 'tok-279' ? 'ready' : 'cooling')),
  });
  await pool.restore();
  if (options.done) {
    fake.push({
      type: 'report',
      managerId: JOB.id,
      text: '終わった',
      status: 'done',
    } as RunnerEvent);
    await settle();
  }
  fake.behavior.background = 1;
  fake.resumes.length = 0;
  fake.sends.length = 0;
  const rotate = (): void => {
    identity = { tokenId: 'tok-279', generation: 279 };
  };
  const forget = (): void => {
    identity = undefined;
  };
  return { pool, fake, stores, inbox, rotate, forget };
}

function closedByLimit(): RunnerEvent {
  return {
    type: 'closed',
    managerId: JOB.id,
    status: 'failed',
    reason: LIMIT_TEXT,
  } as RunnerEvent;
}

function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: JOB.id,
    text: `[failed] ${LIMIT_TEXT}`,
    status: 'done',
    failure: { code: 'rate_limit', via: 'assistant', status: 429 },
  } as RunnerEvent;
}

async function wakeDecisions(s: Awaited<ReturnType<typeof setup>>) {
  return (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
    JSON.stringify(e).includes('回転の出来事を待たずに起こし直す'),
  );
}

describe('古い鍵で枠に当たった担当は、現役の鍵が通るなら回転の出来事を待たずに起こし直す（#4980）', () => {
  it('⭐ 回転の後に預かった done が closed(429) で落ちたら、resumeStoppedByUsage を呼ばずに起こし直され、預かりも届く', async () => {
    const s = await setup();
    s.rotate();
    expect((await s.pool.send(JOB.id, '続きをお願い')).outcome).toBe('held');

    s.fake.push(closedByLimit());
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    const decisions = await wakeDecisions(s);
    expect(decisions).toHaveLength(1);
    const text = JSON.stringify(decisions[0]);
    expect(text).toContain('世代 278');
    expect(text).toContain('世代 279');
    expect(text).toContain('tok-279');
    expect(text).toContain('#4980');
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();

    s.fake.behavior.background = 0;
    await s.pool.deliverHeldMessages?.();
    await settle();
    const delivered = [
      ...s.fake.resumes.map((r) => r.message ?? ''),
      ...s.fake.sends.map((x) => x.text),
    ].join('\n');
    expect(delivered).toContain('続きをお願い');
    const job = (await s.stores.jobs.listJobs())[0];
    expect(job?.heldMessages ?? []).toEqual([]);
    await s.pool.stop();
  });

  it('⭐ report の枝（failure 付きの報告で 429）でも、同じく起こし直す', async () => {
    const s = await setup({ done: false });
    s.rotate();
    // 背景処理は残さない: 残っていれば、枠で止まってから待ちの上限（15 分）までは畳まずに待つ（#5044。`manager-usage-wake-fold.test.ts`）
    s.fake.behavior.background = 0;

    s.fake.push(failedReport());
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(await wakeDecisions(s)).toHaveLength(1);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });

  describe('ターンの途中の usage_notice で印が先に立っていても、失敗の報告で終わったら起こし直す', () => {
    // 回転の後も古い鍵のセッションで走っていた担当が、次のターンの途中で usage_notice（reached）を受け、
    // そのまま 429 の報告で終わる形。印は通知で先に立つので、報告の枝が「新しく立てた」とは見ない
    function reachedNotice(): RunnerEvent {
      return {
        type: 'usage_notice',
        managerId: JOB.id,
        notice: { kind: 'reached', text: LIMIT_TEXT },
      } as RunnerEvent;
    }

    it('⭐ 現役の鍵が通るなら、回転の出来事を待たずに起こし直し、印を下ろす', async () => {
      const s = await setup({ done: false });
      s.rotate();
      s.fake.behavior.background = 0;

      s.fake.push(reachedNotice());
      s.fake.push(failedReport());
      await settle();

      expect(s.fake.resumes).toHaveLength(1);
      expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
      expect(await wakeDecisions(s)).toHaveLength(1);
      expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
      await s.pool.stop();
    });

    it('現役の鍵が通らないなら起こさず、印を残す', async () => {
      const s = await setup({ done: false, availability: async () => 'cooling' });
      s.rotate();
      s.fake.behavior.background = 0;

      s.fake.push(reachedNotice());
      s.fake.push(failedReport());
      await settle();

      expect(s.fake.resumes).toHaveLength(0);
      expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
      await s.pool.stop();
    });

    it('回転していない（世代が同じ）なら起こさない', async () => {
      const s = await setup({ done: false, availability: async () => 'ready' });
      s.fake.behavior.background = 0;

      s.fake.push(reachedNotice());
      s.fake.push(failedReport());
      await settle();

      expect(s.fake.resumes).toHaveLength(0);
      expect(await wakeDecisions(s)).toHaveLength(0);
      await s.pool.stop();
    });
  });

  describe('背景処理を待たされていた担当が、そのまま failed で終わったら、待ちの上限を待たずに起こし直す', () => {
    // 2026-10-19 の HOUSE-17・PROFILE-2・PARTY-2: 古い鍵のまま枠で止まり、起こし直しは背景処理 1 本を待って断られ、
    // その後セッションが failed で終わっても15分の上限まで誰も起こさなかった。
    async function waitingForBackground(currentKey: { ready: boolean } = { ready: true }) {
      const s = await setup({
        done: true,
        availability: async (tokenId) =>
          tokenId === 'tok-279' && currentKey.ready ? 'ready' : 'cooling',
      });
      s.rotate();
      s.fake.push(failedReport());
      await settle();
      // 前提: 起こし直しは背景処理を待って断られ、印は立ったまま
      expect(s.fake.resumes).toHaveLength(0);
      expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
      return s;
    }

    it.each([
      ['理由が枠の文でない（exited with code 1）', 'Error: Claude Code process exited with code 1'],
      ['理由が枠の文', `Error: Claude Code returned an error result: ${LIMIT_TEXT}`],
    ])('⭐ %s', async (_label, reason) => {
      const s = await waitingForBackground();
      s.fake.behavior.background = 0;

      s.fake.push({ type: 'closed', managerId: JOB.id, status: 'failed', reason } as RunnerEvent);
      await settle();

      expect(s.fake.resumes).toHaveLength(1);
      expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
      expect(await wakeDecisions(s)).toHaveLength(2);
      expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
      await s.pool.stop();
    });

    it('現役の鍵がもう通らないなら起こさず、印を残す', async () => {
      const currentKey = { ready: true };
      const s = await waitingForBackground(currentKey);
      s.fake.behavior.background = 0;
      currentKey.ready = false;

      s.fake.push({
        type: 'closed',
        managerId: JOB.id,
        status: 'failed',
        reason: 'Error: Claude Code process exited with code 1',
      } as RunnerEvent);
      await settle();

      expect(s.fake.resumes).toHaveLength(0);
      expect(await wakeDecisions(s)).toHaveLength(1);
      expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
      await s.pool.stop();
    });
  });

  it('現役の鍵が cooling なら起こさず、印を残す', async () => {
    const s = await setup({ done: true, availability: async () => 'cooling' });
    s.rotate();

    s.fake.push(closedByLimit());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect(await wakeDecisions(s)).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
    await s.pool.stop();
  });

  it('世代が同じ（回転していない）なら起こさない', async () => {
    const s = await setup({ done: true, availability: async () => 'ready' });

    s.fake.push(closedByLimit());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect(await wakeDecisions(s)).toHaveLength(0);
    await s.pool.stop();
  });

  it('現役の世代が分からない（tokenIdentity が返さない）なら起こさない', async () => {
    const s = await setup({ done: true, availability: async () => 'ready' });
    s.forget();

    s.fake.push(closedByLimit());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect(await wakeDecisions(s)).toHaveLength(0);
    await s.pool.stop();
  });

  it('tokenAvailability が例外を投げたら起こさず、印を残す', async () => {
    const s = await setup({
      done: true,
      availability: async () => {
        throw new Error('読めない');
      },
    });
    s.rotate();

    s.fake.push(closedByLimit());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
    await s.pool.stop();
  });
});
