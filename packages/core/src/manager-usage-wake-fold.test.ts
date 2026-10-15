import { describe, expect, it } from 'vitest';

import { HELD_FORCE_FOLD_AFTER_MS, createManagerPool, type ManagerPoolOptions } from './manager.js';
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
import { createMemoryStores } from './testing.js';

// 鍵の回転の起こし直しは、背景処理を理由に止めない。届かなければ掃きが間隔を伸ばして挑み直す（#4850）

const JOB: Job = {
  id: 'mgr-fold',
  managerId: 'mgr-fold',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const MINUTE = 60_000;

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const stops: string[] = [];
  const counters = { lists: 0 };
  const behavior: {
    background: number | 'absent';
    commands: string[] | undefined;
    waiting: RunnerManagerState['waiting'];
  } = { background: 0, commands: undefined, waiting: [] };

  const stateOf = (base: RunnerManagerState): RunnerManagerState => ({
    ...base,
    waiting: behavior.waiting,
    ...(behavior.background === 'absent' ? {} : { liveBackgroundTasks: behavior.background }),
    ...(behavior.commands === undefined ? {} : { backgroundTaskCommands: behavior.commands }),
  });

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
      counters.lists += 1;
      return alive.map(stateOf);
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
    counters,
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

async function setup(tokenAvailability: ManagerPoolOptions['tokenAvailability']) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const active = { tokenId: 'tok-a', generation: 59 };
  const clock = { now: Date.parse('2026-10-15T03:00:00.000Z') };
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ ...active }),
    ...(tokenAvailability === undefined ? {} : { tokenAvailability }),
    now: () => clock.now,
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  // 枠で止まって done になった担当（印が立つ）。その後で鍵が回る
  fake.push({
    type: 'usage_notice',
    managerId: 'mgr-fold',
    notice: { kind: 'reached', text: "You've hit your individual spend limit for this account." },
  } as RunnerEvent);
  fake.push({
    type: 'report',
    managerId: 'mgr-fold',
    text: "[failed] You've hit your individual spend limit for this account.",
    status: 'done',
    failure: { code: 'usage_limit', via: 'result' },
  } as RunnerEvent);
  await settle();
  active.tokenId = 'tok-b';
  active.generation = 60;
  return { pool, fake, stores, clock };
}

const SECRET = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

describe('鍵の回転の起こし直しは、背景処理を理由に止めない（#4850 直し方1）', () => {
  it('⭐ (a) 背景処理 1 本・古い鍵が冷却中: 畳んで新しい鍵で起こし直し、一言に畳んだ本数とコマンドを載せる（秘密は伏せる）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 1;
    s.fake.behavior.commands = [`pnpm dev --token ${SECRET}`];

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-fold']);
    expect(s.fake.stops).toEqual(['mgr-fold']);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('認証トークンが枠で止まっていた');
    expect(message).toContain('背景処理 1 本');
    expect(message).toContain('pnpm dev --token');
    expect(message).not.toContain(SECRET);
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('背景処理 1 本ごと畳んで'),
    );
    expect(decisions).toHaveLength(1);
    expect(JSON.stringify(decisions[0])).toContain('#4850');
    const jobs = await s.stores.jobs.listJobs();
    expect(jobs[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });

  it('(a2) コマンドが取れない（古い runner）ときは本数だけを載せる', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 2;

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-fold']);

    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('背景処理 2 本');
    expect(message).not.toContain('コマンド');
    await s.pool.stop();
  });

  it('(b) 古い鍵が ready なら、畳まずに旧セッションへ届ける（今どおり）', async () => {
    const s = await setup(async () => 'ready');
    s.fake.behavior.background = 1;

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-fold']);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('認証トークンが枠で止まっていた');
    await s.pool.stop();
  });

  it('(c) 確認待ちが残る担当は、畳まない（今どおり）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 1;
    s.fake.behavior.waiting = [
      {
        requestId: 'req-1',
        summary: 'Bash を許可するか',
        kind: 'permission',
        askedAt: '2026-10-05T01:00:00.000Z',
      },
    ];

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);
    await s.pool.stop();
  });

  it('(c2) 背景処理の本数が分からない（古い runner）担当も、畳まない（今どおり）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 'absent';

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    await s.pool.stop();
  });

  it('(e) 人間・クローンの普通の manager_send は、背景処理があれば今どおり預かる（15 分までは畳まない）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 1;

    const result = await s.pool.send('mgr-fold', '続きを');

    expect(result.outcome).toBe('held');
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);

    s.clock.now += HELD_FORCE_FOLD_AFTER_MS - 1;
    const again = await s.pool.send('mgr-fold', 'もう一度');
    expect(again.outcome).toBe('held');
    expect(s.fake.stops).toHaveLength(0);
    await s.pool.stop();
  });
});

describe('起こし直しが届かなかったら、掃きが間隔を伸ばして挑み直す（#4850 直し方3）', () => {
  it('⭐ (d) 1分・2分・4分と間隔が伸び、成功したら止む', async () => {
    const s = await setup(async () => 'cooling');
    // 本数が分からない間は断られる（空振り）
    s.fake.behavior.background = 'absent';
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    const jobs = await s.stores.jobs.listJobs();
    expect(jobs[0]?.usageStoppedAt).toBeDefined();

    // 試行の回数は、runner の一覧を読んだ回数で数える（断られた回は send を出さない）
    const attempts = async (): Promise<number> => {
      const before = s.fake.counters.lists;
      expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
      return s.fake.counters.lists - before;
    };

    // 間隔が経つ前は挑まない
    expect(await attempts()).toBe(0);
    s.clock.now += MINUTE - 1;
    expect(await attempts()).toBe(0);

    // 1分後: 挑む（また空振り。次は2分後）
    s.clock.now += 1;
    expect(await attempts()).toBeGreaterThan(0);
    s.clock.now += MINUTE;
    expect(await attempts()).toBe(0);
    s.clock.now += MINUTE;
    expect(await attempts()).toBeGreaterThan(0);

    // 3回目の空振りの後は4分後
    s.clock.now += 3 * MINUTE;
    expect(await attempts()).toBe(0);
    s.clock.now += MINUTE;
    expect(await attempts()).toBeGreaterThan(0);

    // 上限は30分: 十分に伸びた後でも、30分を空ければ必ず挑む
    for (let i = 0; i < 6; i += 1) {
      s.clock.now += 30 * MINUTE;
      await s.pool.settleStalledUsageWakes();
    }
    s.clock.now += 30 * MINUTE;
    expect(await attempts()).toBeGreaterThan(0);

    // 成功: 畳めるようになった回で起こし直され、印が下りる。その後は挑まない
    s.fake.behavior.background = 1;
    s.clock.now += 30 * MINUTE;
    expect(await s.pool.settleStalledUsageWakes()).toEqual(['mgr-fold']);
    expect(s.fake.resumes).toHaveLength(1);
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    s.clock.now += 60 * MINUTE;
    expect(await attempts()).toBe(0);
    expect(s.fake.resumes).toHaveLength(1);
    await s.pool.stop();
  });
});
