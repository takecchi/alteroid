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

// 使用量の起こし直し（`manager-usage-resume` ほか）を、掃きの側を別のクラスへ切り出しても崩さないための縛り。
// 公開の口（ManagerPool のメソッドと偽の runner・store）だけで書く。Pool の非公開の欄は読まない。

const ID = 'mgr-usage-guards';

const JOB: Job = {
  id: ID,
  managerId: ID,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-guards',
  runnerId: 'runner-primary',
};

const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 30, 3am (UTC)";

type Availability = 'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined;

function fakeRunner(log: string[]) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const control = { failDelivery: false, background: 0 };
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
    async send(managerId, text) {
      log.push(`send:${text}`);
      sends.push({ managerId, text });
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
      return alive.map((state) => ({
        ...state,
        waiting: [],
        liveBackgroundTasks: control.background,
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
    job?: Job;
    availability?: ManagerPoolOptions['tokenAvailability'];
    tokenIdentity?: ManagerPoolOptions['tokenIdentity'];
    stores?: ReturnType<typeof createMemoryStores>;
  } = {},
) {
  const stores = options.stores ?? createMemoryStores();
  if (options.stores === undefined) await stores.jobs.putJob(options.job ?? JOB);
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
    now: () => clock.now,
    tokenIdentity:
      options.tokenIdentity ?? (() => ({ tokenId: 'tok-a', generation: key.generation })),
    tokenAvailability: options.availability ?? (async () => key.availability),
    onUsageObservation: async (observation) => {
      log.push(`observation:${observation.notice.kind}`);
    },
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  log.length = 0;
  return { pool, fake, stores, inbox, clock, key, log };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: ID,
    text: `[failed] ${LIMIT_TEXT}`,
    status: 'done',
    failure: { code: 'rate_limit', via: 'assistant', status: 429 },
  } as RunnerEvent;
}

function workerLimitNote(preRotationKey: boolean): RunnerEvent {
  return {
    type: 'note',
    managerId: ID,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    workerLimit: { raw: "You've hit your weekly limit", preRotationKey },
  } as RunnerEvent;
}

describe('1つの報告で使用量・作業者の上限・鍵の回転の3条件が全部立ったときの呼ぶ順', () => {
  it('⭐ 失敗の報告 1 つに対し、使用量の起こし直し → 作業者の上限の起こし直し → 鍵の回転の依頼の順で走る（case report の枝）', async () => {
    const s = await setup();
    // 借り: 走っている最中に回し手が resumeStoppedByUsage を呼んだ形（印はまだ無い）
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    // 作業者の落ち（回転前の鍵）。印は担当が done で終わった時点の判定が拾う
    s.fake.push(workerLimitNote(true));
    await settle();
    // どの起こし直しも届かない（印は残り、3つ目の条件まで落ちずに通る）
    s.fake.control.failDelivery = true;
    s.log.length = 0;

    s.fake.push(failedReport());
    await settle();

    const steps = s.log
      .map((line) => {
        if (line.startsWith('observation:')) return 'rotation-request';
        if (line.includes('作業者が上限で落ちた鍵は回った')) return 'worker-limit-wake';
        if (line.includes('通る鍵に戻った')) return 'usage-wake';
        return line;
      })
      .filter((step, at, all) => all.indexOf(step) === at);
    // 使用量の起こし直し（届けるために送りも resume も試すので、同じ段の連続は 1 つに畳む）が先、作業者の上限が次、鍵の回転の依頼が最後
    expect(steps).toEqual(['usage-wake', 'worker-limit-wake', 'rotation-request']);
    await s.pool.stop();
  });
});
