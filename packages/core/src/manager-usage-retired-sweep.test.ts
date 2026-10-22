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

// #5166: 動いているデーモンの上で枠に当たって failed になり、像から外れた担当を、鍵の出来事が来ないまま通る状態へ戻ったあと、
// 周回の掃き（settleStalledUsageWakes）が起こす。起こすのは「現役の鍵が ready」かつ「止まった後に戻ったと言える」ときだけ。

const ID = 'mgr-5166';

const JOB: Job = {
  id: ID,
  managerId: ID,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T01:00:00.000Z',
  status: 'running',
  summary: '監査',
  request: '監査して',
  cwd: '/work/project',
  sessionId: 'sess-5166',
  runnerId: 'runner-primary',
};

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const control = { failResume: false };
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
      if (control.failResume) throw new Error('この検証が仕込んだ resume の失敗');
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
      // resume の失敗後の「居るか」の確かめ（#4715）が、setup の resume で入れたセッションを見つけて「効いた」へ倒れないように
      return control.failResume ? [] : [...alive];
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

type Availability = 'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined;

async function setup(options: { generationAtFailure?: number } = {}) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const clock = { now: Date.parse('2026-10-22T00:00:00.000Z') };
  const key = {
    generation: options.generationAtFailure ?? 1,
    availability: 'cooling' as Availability,
  };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock.now,
    tokenIdentity: () => ({ tokenId: 'tok-a', generation: key.generation }),
    tokenAvailability: async () => key.availability,
    // 鍵の出来事は出ない（回し手は何もしない）: 掃きだけが拾える形
    onUsageObservation: async () => undefined,
  });
  await pool.restore();
  fake.resumes.length = 0;
  return { pool, fake, stores, inbox, clock, key };
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

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function failedByQuota(s: Awaited<ReturnType<typeof setup>>) {
  s.fake.push(sessionDiedBy429());
  await settle();
  const job = (await s.stores.jobs.listJobs())[0];
  expect(job?.status).toBe('failed');
  expect(job?.usageStoppedAt).toBeDefined();
  expect(s.fake.resumes).toHaveLength(0);
}

async function setCooldown(s: Awaited<ReturnType<typeof setup>>, until: number | undefined) {
  await s.stores.tokens.replace([
    { id: 'tok-a', label: 'a', order: 0, ...(until === undefined ? {} : { cooldownUntil: until }) },
  ]);
}

// 現役の鍵の行を直に置く（成功の観測は `markTokenUsable` が `updatedAt` を進めて `lastRejectedAt` と `cooldownUntil` を消した形）
async function setRow(
  s: Awaited<ReturnType<typeof setup>>,
  row: { updatedAt?: number; lastRejectedAt?: number; cooldownUntil?: number },
) {
  await s.stores.tokens.replace([
    {
      id: 'tok-a',
      label: 'a',
      order: 0,
      ...(row.updatedAt === undefined ? {} : { updatedAt: new Date(row.updatedAt).toISOString() }),
      ...(row.lastRejectedAt === undefined
        ? {}
        : { lastRejectedAt: new Date(row.lastRejectedAt).toISOString() }),
      ...(row.cooldownUntil === undefined ? {} : { cooldownUntil: row.cooldownUntil }),
    },
  ]);
}

const MIN = 60_000;

describe('枠で failed になり像から外れた担当を、掃きが起こす（#5166）', () => {
  it('⭐ 鍵の出来事が来ないまま、現役の鍵の世代が変わって ready に戻ったら、次の掃きで起こされ、一言に新しい一文が入る', async () => {
    const s = await setup();
    s.key.availability = 'cooling';
    await failedByQuota(s);

    // 通らない間は起こさない
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);

    s.key.generation = 2;
    s.key.availability = 'ready';
    expect(await s.pool.settleStalledUsageWakes()).toEqual([ID]);

    expect(s.fake.resumes.map((c) => [c.managerId, c.sessionId])).toEqual([[ID, 'sess-5166']]);
    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('通る鍵に戻った');
    expect(message).toContain(
      'まず作業ツリーと枝の状態を測り、未 push のコミットがあれば先に push してから、止まった所から続けること。',
    );
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    const entries = await s.stores.journal.list({ limit: 200 });
    expect(
      entries.some(
        (e) => e.type === 'exchange' && e.text.includes('起こし直した') && e.text.includes(ID),
      ),
    ).toBe(true);
  });

  it('世代が同じでも、冷却明けが止まった時刻より後で、もう過ぎていれば起こす', async () => {
    const s = await setup();
    await failedByQuota(s);
    const stoppedAt = Date.parse((await s.stores.jobs.listJobs())[0]?.usageStoppedAt ?? '');

    s.key.availability = 'ready';
    await setCooldown(s, stoppedAt + 5 * MIN);
    s.clock.now = stoppedAt + 10 * MIN;
    expect(await s.pool.settleStalledUsageWakes()).toEqual([ID]);
    expect(s.fake.resumes).toHaveLength(1);
  });

  it('ready でなければ、材料が揃っていても起こさない（印は残る）', async () => {
    const s = await setup();
    await failedByQuota(s);
    const stoppedAt = Date.parse((await s.stores.jobs.listJobs())[0]?.usageStoppedAt ?? '');
    await setCooldown(s, stoppedAt + 5 * MIN);
    s.clock.now = stoppedAt + 10 * MIN;
    s.key.generation = 2;

    for (const availability of ['cooling', 'disabled', 'invalidated', undefined] as const) {
      s.key.availability = availability;
      expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    }
    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
  });

  it('ready でも、同じ世代のまま冷却明けが止まった時刻より前・または記録が無ければ起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    const stoppedAt = Date.parse((await s.stores.jobs.listJobs())[0]?.usageStoppedAt ?? '');
    s.key.availability = 'ready';
    s.clock.now = stoppedAt + 10 * MIN;

    // 記録が無い
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    // 止まった時刻より前に明けていた（止まった後の戻りではない）
    await setCooldown(s, stoppedAt - MIN);
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    // 止まった時刻より後だが、まだ過ぎていない
    await setCooldown(s, stoppedAt + 20 * MIN);
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);

    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();
  });

  it('⭐ 同じ世代のまま冷却明けが消えて、止まった後の成功が観測されていれば（鍵が尽きて同じ鍵に戻る形）起こす', async () => {
    const s = await setup();
    await failedByQuota(s);
    const stoppedAt = Date.parse((await s.stores.jobs.listJobs())[0]?.usageStoppedAt ?? '');

    s.key.availability = 'ready';
    await setRow(s, { updatedAt: stoppedAt + 5 * MIN });
    s.clock.now = stoppedAt + 10 * MIN;
    expect(await s.pool.settleStalledUsageWakes()).toEqual([ID]);
    expect(s.fake.resumes).toHaveLength(1);
  });

  it('成功の観測の材料: 行の更新が止まった時刻より前なら起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    const stoppedAt = Date.parse((await s.stores.jobs.listJobs())[0]?.usageStoppedAt ?? '');

    s.key.availability = 'ready';
    s.clock.now = stoppedAt + 10 * MIN;
    await setRow(s, { updatedAt: stoppedAt - MIN });
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    // 更新の時刻が無い行も同じ（分からないは起こさない）
    await setRow(s, {});
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('成功の観測の材料: 拒否の記録（lastRejectedAt）が残っていれば、更新が後でも起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    const stoppedAt = Date.parse((await s.stores.jobs.listJobs())[0]?.usageStoppedAt ?? '');

    s.key.availability = 'ready';
    s.clock.now = stoppedAt + 10 * MIN;
    await setRow(s, { updatedAt: stoppedAt + 5 * MIN, lastRejectedAt: stoppedAt + 5 * MIN });
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('人が止めた担当（stopped）は、印が残っていて材料が揃っていても起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    await s.pool.abort(ID);
    s.fake.resumes.length = 0;

    s.key.generation = 2;
    s.key.availability = 'ready';
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.status).toBe('stopped');
  });

  it('後継の居る担当は、起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    const job = (await s.stores.jobs.listJobs())[0];
    if (job === undefined) throw new Error('台帳に居ない');
    await s.stores.jobs.putJob({ ...job, supersededBy: 'mgr-successor' });

    s.key.generation = 2;
    s.key.availability = 'ready';
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('枠以外の理由で failed になった担当（印が立たない）は、起こさない', async () => {
    const s = await setup();
    s.fake.push({
      type: 'closed',
      managerId: ID,
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: Error: spawn EAGAIN',
    } as RunnerEvent);
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();

    s.key.generation = 2;
    s.key.availability = 'ready';
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('掃きと resumeStoppedByUsage() が続けて触っても、二重には起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    s.key.generation = 2;
    s.key.availability = 'ready';

    expect(await s.pool.settleStalledUsageWakes()).toEqual([ID]);
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
  });

  it('逆順（resumeStoppedByUsage() が先）でも二重には起こさない', async () => {
    const s = await setup();
    await failedByQuota(s);
    s.key.generation = 2;
    s.key.availability = 'ready';

    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
  });

  it('起こして届かなかった回は挑み直しの状態に乗り、間隔が延びる（1分・2分）', async () => {
    const s = await setup();
    await failedByQuota(s);
    s.key.generation = 2;
    s.key.availability = 'ready';
    s.fake.control.failResume = true;

    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeDefined();

    // 1分に満たない: 挑まない
    s.clock.now += MIN - 1;
    await s.pool.settleStalledUsageWakes();
    expect(s.fake.resumes).toHaveLength(1);

    // 1分後: 2回目（また届かない）
    s.clock.now += 1;
    await s.pool.settleStalledUsageWakes();
    expect(s.fake.resumes).toHaveLength(2);

    // 間隔は2分へ延びている: 1分では挑まない
    s.clock.now += MIN;
    await s.pool.settleStalledUsageWakes();
    expect(s.fake.resumes).toHaveLength(2);

    // 届くようになれば起こされ、印が下りる
    s.fake.control.failResume = false;
    s.clock.now += MIN;
    expect(await s.pool.settleStalledUsageWakes()).toEqual([ID]);
    expect(s.fake.resumes).toHaveLength(3);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
  });
});
