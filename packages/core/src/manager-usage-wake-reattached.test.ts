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
import type { Job } from './schema.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { createMemoryStores } from './testing.js';

// 鍵の回転の後にデーモンが作り直され、古い鍵のまま走っていたセッションを引き取った（世代は覚えていない・指紋だけが在る）担当が、
// その後に枠で落ちたら、回転の出来事を待たずに起こし直す。回し手は古い指紋の観測を stale として無視するので、ここで起こさないと次の回転まで止まる

const JOB: Job = {
  id: 'mgr-reattached',
  managerId: 'mgr-reattached',
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const OLD_FP = 'aaaaaaaaaaaa';
const NEW_FP = 'bbbbbbbbbbbb';
const LIMIT_TEXT = "You've hit your session limit · resets 1:20pm (Asia/Tokyo)";

function fakeRunner(sessionFingerprint: string) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [
    {
      managerId: JOB.id,
      status: 'running',
      cwd: '/work/project',
      request: '調べておいて',
      waiting: [],
      sessionId: 'sess-1',
      tokenFingerprint: sessionFingerprint,
      liveBackgroundTasks: 0,
    },
  ];
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
        tokenFingerprint: NEW_FP,
        liveBackgroundTasks: 0,
      });
      return {};
    },
    async send() {
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
    resumes,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function reattached(
  options: {
    sessionFingerprint?: string;
    availability?: ManagerPoolOptions['tokenAvailability'];
  } = {},
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner(options.sessionFingerprint ?? OLD_FP);
  const registry = createRunnerRegistry([fake.runner]);
  const observations: TokenRotatorObservation[] = [];
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ tokenId: 'tok-new', generation: 325, fingerprint: NEW_FP }),
    tokenAvailability:
      options.availability ?? (async (tokenId) => (tokenId === 'tok-new' ? 'ready' : 'cooling')),
    onUsageObservation: async (observation) => {
      observations.push(observation);
      return { kind: 'ignored', why: 'この検証では回さない' } as never;
    },
  });
  await pool.restore();
  // 引き取った後の1ターンがふつうに終わる: 引き取りで載せた起こし直しの借り（#4643）はここで下りる。セッションは古い鍵のまま
  fake.push({ type: 'report', managerId: JOB.id, text: '途中まで', status: 'done' } as RunnerEvent);
  await settle();
  // 前提: 生きたセッションを引き取っただけで、世代は覚えていない
  const summary = (await pool.list()).find((s) => s.managerId === JOB.id);
  expect(summary?.tokenGeneration).toBeUndefined();
  expect(fake.resumes).toHaveLength(0);
  return { pool, fake, stores, observations };
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

function closedByLimit(): RunnerEvent {
  return {
    type: 'closed',
    managerId: JOB.id,
    status: 'failed',
    reason: `Error: Claude Code returned an error result: ${LIMIT_TEXT}`,
  } as RunnerEvent;
}

async function wakeDecisions(stores: ReturnType<typeof createMemoryStores>) {
  return (await stores.journal.list({ types: ['decision'] })).filter((e) =>
    JSON.stringify(e).includes('回転の出来事を待たずに起こし直す'),
  );
}

describe('再起動で引き取った古い鍵のセッションが枠で落ちたら、指紋で古いと分かれば起こし直す', () => {
  it('⭐ 失敗の報告（429）で終わったら、新しい鍵で起こし直し、印を下ろす', async () => {
    const s = await reattached();

    s.fake.push(failedReport());
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(await wakeDecisions(s.stores)).toHaveLength(1);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });

  it('⭐ closed(failed) で落ちたら、像を外した後でも起こし直し、回し手へは古い指紋を添える', async () => {
    const s = await reattached();

    s.fake.push(closedByLimit());
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(await wakeDecisions(s.stores)).toHaveLength(1);
    const reached = s.observations.find((o) => o.notice?.kind === 'reached');
    expect(reached?.observedBy).toEqual({ fingerprint: OLD_FP });
    await s.pool.stop();
  });

  it('指紋が現役と同じなら起こさない', async () => {
    const s = await reattached({ sessionFingerprint: NEW_FP });

    s.fake.push(failedReport());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect(await wakeDecisions(s.stores)).toHaveLength(0);
    await s.pool.stop();
  });

  it('現役の鍵が通らないなら起こさず、印を残す', async () => {
    const s = await reattached({ availability: async () => 'cooling' });

    s.fake.push(failedReport());
    await settle();

    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
    await s.pool.stop();
  });
});
