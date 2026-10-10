import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPoolOptions } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  runnerManagerStateSchema,
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

const JOB: Job = {
  id: 'mgr-stale',
  managerId: 'mgr-stale',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function staleRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const stops: string[] = [];
  const behavior: {
    background: number | 'absent';
    stopIgnored: boolean;
    waiting: RunnerManagerState['waiting'];
  } = { background: 0, stopIgnored: false, waiting: [] };

  const stateOf = (base: RunnerManagerState): RunnerManagerState => ({
    ...base,
    waiting: behavior.waiting,
    ...(behavior.background === 'absent' ? {} : { liveBackgroundTasks: behavior.background }),
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
      if (behavior.stopIgnored) return;
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
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

function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: 'mgr-stale',
    text: "[failed] You've hit your session limit",
    status: 'done',
    failure: { code: 'usage_limit', via: 'result' },
  } as RunnerEvent;
}

async function setup(
  options: { job?: Job; tokenAvailability?: ManagerPoolOptions['tokenAvailability'] } = {},
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(options.job ?? JOB);
  const fake = staleRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const active = { tokenId: 'tok-a', generation: 59 };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ ...active }),
    ...(options.tokenAvailability === undefined
      ? {}
      : { tokenAvailability: options.tokenAvailability }),
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  fake.push(failedReport());
  await settle();
  const rotate = (): void => {
    active.tokenId = 'tok-b';
    active.generation = 60;
  };
  return { pool, fake, stores, active, rotate };
}

async function summaryOf(pool: Awaited<ReturnType<typeof setup>>['pool']) {
  const found = (await pool.list()).find((s) => s.managerId === 'mgr-stale');
  if (found === undefined) throw new Error('mgr-stale が list() に見つからない');
  return found;
}

describe('done の委譲へ send するとき、世代が食い違っていたら新しい鍵で起こし直す（#2851）', () => {
  it('⭐ 再現: 世代が食い違う done・背景処理 0 本 は、旧セッションへ push せず stop → resume で続ける', async () => {
    const s = await setup();
    s.rotate();
    const before = await summaryOf(s.pool);
    expect(before.tokenGeneration).toBe(59);
    expect(before.activeTokenGeneration).toBe(60);

    const result = await s.pool.send('mgr-stale', '続きをお願い');

    expect(result.outcome).toBe('delivered');
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.stops).toEqual(['mgr-stale']);
    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s.fake.resumes[0]?.message).toContain('続きをお願い');
    const after = await summaryOf(s.pool);
    expect(after.tokenGeneration).toBe(60);
    expect(after.activeTokenGeneration).toBe(60);
    await s.pool.stop();
  });

  it('世代が一致している done へは割り込まない（従来どおり生きたセッションへ push）', async () => {
    const s = await setup();

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('delivered');
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 背景処理が1本以上残っている done は、畳まず・流さず、declined で断る', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 2;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('declined');
    expect(result.detail).toContain('背景処理');
    expect(result.detail).toContain('2 本');
    expect(result.detail).toContain('manager_stop');
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 欄の無い古い runner（本数が分からない）も畳まず・流さず、「分からない」と言って断る', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 'absent';

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('declined');
    expect(result.detail).toContain('分からない');
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ runner が確認待ちを抱えていれば断る（detail に確認待ちがあると書く）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.waiting = [
      {
        requestId: 'req-1',
        summary: 'Bash を許可するか',
        kind: 'permission',
        askedAt: '2026-10-05T01:00:00.000Z',
      },
    ];

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('declined');
    expect(result.detail).toContain('確認待ち');
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ sessionId が無く会話を引き継げない done は、畳まずに断る（黙って会話を切らない）', async () => {
    const stores = createMemoryStores();
    const fake = staleRunner();
    const registry = createRunnerRegistry([fake.runner]);
    const active = { tokenId: 'tok-a', generation: 59 };
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
      tokenIdentity: () => ({ ...active }),
    });
    const started = await pool.start({ request: '調べて', cwd: '/work/project' });
    fake.push({
      type: 'report',
      managerId: started.managerId,
      text: '終わった',
      status: 'done',
    } as RunnerEvent);
    await settle();
    active.tokenId = 'tok-b';
    active.generation = 60;

    const result = await pool.send(started.managerId, '続きを');

    expect(result.outcome).toBe('declined');
    expect(result.detail).toContain('sessionId');
    expect(fake.stops).toHaveLength(0);
    expect(fake.sends).toHaveLength(0);
    await pool.stop();
  });

  it('畳めたと確かめられなければ resume しない（二重のセッションを作らない）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.stopIgnored = true;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(s.fake.stops).toEqual(['mgr-stale']);
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);
    expect(result.outcome).toBe('declined');
    expect(result.detail).toContain('畳めた');
    await s.pool.stop();
  });

  it('manager_list の世代の ⚠ は、runner が最後に見た背景処理の本数を添える', async () => {
    const s = await setup();
    s.rotate();
    const summary = await summaryOf(s.pool);
    expect(summary.liveBackgroundTasks).toBeUndefined();
    await s.pool.stop();
  });
});

describe('畳めない理由が残っていても、古い鍵が ready なら旧セッションへ届ける（#4441）', () => {
  const waitingOne: RunnerManagerState['waiting'] = [
    {
      requestId: 'req-1',
      summary: 'Bash を許可するか',
      kind: 'permission',
      askedAt: '2026-10-05T01:00:00.000Z',
    },
  ];

  it('⭐ 世代が食い違い・背景処理 1 本・古い鍵が ready: 旧セッションへ届け、畳まず、detail と日誌に残す', async () => {
    const asked: string[] = [];
    const s = await setup({
      tokenAvailability: async (tokenId) => {
        asked.push(tokenId);
        return 'ready';
      },
    });
    s.rotate();
    s.fake.behavior.background = 1;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('delivered');
    expect(asked).toEqual(['tok-a']);
    expect(s.fake.sends).toEqual([{ managerId: 'mgr-stale', text: '続きを' }]);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    expect(result.detail).toContain('古い鍵（世代 59）のまま旧セッションへ届けた');
    expect(result.detail).toContain('背景処理が 1 本');
    expect(result.detail).toContain('新しい鍵で起こし直していない');
    expect(result.detail).toContain('ready');
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('旧セッションへ届ける'),
    );
    expect(decisions).toHaveLength(1);
    expect(JSON.stringify(decisions[0])).toContain('mgr-stale');
    await s.pool.stop();
  });

  it('確認待ちが理由のときも、古い鍵が ready なら旧セッションへ届ける', async () => {
    const s = await setup({ tokenAvailability: async () => 'ready' });
    s.rotate();
    s.fake.behavior.waiting = waitingOne;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('delivered');
    expect(result.detail).toContain('確認待ちが 1 件');
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.stops).toHaveLength(0);
    await s.pool.stop();
  });

  it.each(['cooling', 'disabled', 'invalidated', undefined] as const)(
    '⚠️ 古い鍵が %s なら従来どおり declined（送らず・畳まない）',
    async (state) => {
      const s = await setup({ tokenAvailability: async () => state });
      s.rotate();
      s.fake.behavior.background = 1;

      const result = await s.pool.send('mgr-stale', '続きを');

      expect(result.outcome).toBe('declined');
      expect(s.fake.sends).toHaveLength(0);
      expect(s.fake.stops).toHaveLength(0);
      await s.pool.stop();
    },
  );

  it('⚠️ 注入口を渡さなければ従来どおり declined', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('declined');
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.stops).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 注入口が投げたら declined（送らず・畳まない）', async () => {
    const s = await setup({
      tokenAvailability: async () => {
        throw new Error('プールを読めない');
      },
    });
    s.rotate();
    s.fake.behavior.background = 1;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(result.outcome).toBe('declined');
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.stops).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 畳めない理由が背景処理でなく sessionId 無しでも混じれば、ready でも declined（絞った範囲）', async () => {
    const stores = createMemoryStores();
    const fake = staleRunner();
    const registry = createRunnerRegistry([fake.runner]);
    const active = { tokenId: 'tok-a', generation: 59 };
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
      tokenIdentity: () => ({ ...active }),
      tokenAvailability: async () => 'ready',
    });
    const started = await pool.start({ request: '調べて', cwd: '/work/project' });
    fake.push({
      type: 'report',
      managerId: started.managerId,
      text: '終わった',
      status: 'done',
    } as RunnerEvent);
    await settle();
    active.tokenId = 'tok-b';
    active.generation = 60;
    fake.behavior.background = 1;

    const result = await pool.send(started.managerId, '続きを');

    expect(result.outcome).toBe('declined');
    expect(fake.sends).toHaveLength(0);
    expect(fake.stops).toHaveLength(0);
    await pool.stop();
  });
});

describe('版が混ざる窓: runner と daemon は別々にデプロイされる', () => {
  const base = {
    managerId: 'm',
    status: 'done',
    cwd: '/w',
    request: 'r',
    waiting: [],
  };

  it('新しい daemon は、欄の無い古い runner の応答を読める（本数は「分からない」）', () => {
    const parsed = runnerManagerStateSchema.parse(base);
    expect(parsed.liveBackgroundTasks).toBeUndefined();
  });

  it('新しい daemon は、欄付きの応答を読める', () => {
    expect(
      runnerManagerStateSchema.parse({ ...base, liveBackgroundTasks: 3 }).liveBackgroundTasks,
    ).toBe(3);
  });

  it('古い daemon（欄を知らない schema）は、欄付きの応答を落とさず読める（未知の欄は捨てる）', () => {
    const legacy = runnerManagerStateSchema.pick({
      managerId: true,
      status: true,
      cwd: true,
      request: true,
      waiting: true,
      sessionId: true,
    });
    const parsed = legacy.safeParse({ ...base, liveBackgroundTasks: 3 });
    expect(parsed.success).toBe(true);
  });

  it('負数・小数は欄として受け付けない', () => {
    expect(runnerManagerStateSchema.safeParse({ ...base, liveBackgroundTasks: -1 }).success).toBe(
      false,
    );
    expect(runnerManagerStateSchema.safeParse({ ...base, liveBackgroundTasks: 1.5 }).success).toBe(
      false,
    );
  });
});
