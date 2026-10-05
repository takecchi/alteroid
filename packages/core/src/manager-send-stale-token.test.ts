import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
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

/**
 * **done の委譲へ `send` するとき、認証トークンの世代が食い違っていたら、旧セッションへ
 * 流し込まずに新しい鍵で起こし直してから続ける**（Issue #2851）。
 *
 * ## 症状
 *
 * 鍵が 59 → 60 に回った後、done だった委譲（セッションは runner に生きている。
 * 台帳の `attached` は true のまま）へ `manager_send` すると、`send()` は
 * `runner.send()` で旧プロセスへ追加指示を積むだけで、新しいセッションを起こさない。
 * 旧プロセスの env は凍っているので、また古い鍵で 429 になる。しかも
 * `#tokenIdentities` も更新されないので、`manager_list` の ⚠ も消えない。
 * failed（`attached` が false）は resume に落ちるので新しい鍵になる。
 *
 * ## ここが固定するもの
 *
 * - 食い違う done・背景処理 0 本: stop → resume（同じ sessionId・同じ message）。`runner.send` は呼ばない
 * - 背景処理が1本以上 / 確認待ちが在る / 本数が分からない（欄の無い古い runner）:
 *   **畳まず、旧セッションへも流さず**、`declined` で断る（detail に何が残っているかと取れる手）
 * - 世代が一致・running なら従来どおり push（割り込まない）
 * - 版が混ざる窓（欄あり・欄なし）で zod が落ちない
 */

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

/** 載っているセッションの runner 側の状態を操れる偽 runner。 */
function staleRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const stops: string[] = [];
  const behavior: {
    /** `list()` が返す `liveBackgroundTasks`。`'absent'` は欄そのものを返さない（古い runner）。 */
    background: number | 'absent';
    /** `stop()` を受けても一覧から消さない（畳めなかった回を作る）。 */
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

/** 枠の失敗でターンが終わった回の報告（セッションは生きている）。 */
function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: 'mgr-stale',
    text: "[failed] You've hit your session limit",
    status: 'done',
    failure: { code: 'usage_limit', via: 'result' },
  } as RunnerEvent;
}

/**
 * 世代 59 で起きた委譲が、枠に当たって done になり、その後に現役が 60 へ回った状態を作る。
 * `restore()` が resume を投げる瞬間に世代 59 を控える（`#rememberTokenIdentity`）。
 */
async function setup(options: { job?: Job } = {}) {
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
    // 旧プロセスへは流さない。
    expect(s.fake.sends).toHaveLength(0);
    // 畳んでから、同じ会話（sessionId）で、同じ本文を添えて開き直す。
    expect(s.fake.stops).toEqual(['mgr-stale']);
    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s.fake.resumes[0]?.message).toContain('続きをお願い');
    // 抱えている世代が追いつき、⚠ は消える。
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
    const s = await setup();
    s.rotate();
    const record = (await s.stores.jobs.listJobs()).find((j) => j.id === 'mgr-stale');
    expect(record).toBeDefined();
    // 台帳の sessionId を落とす（resume できない状態）。
    await s.stores.jobs.putJob({ ...(record as Job), sessionId: undefined });
    // プロセス内の像にも反映させるため、別のプールで開き直す。
    const reopened = createRunnerRegistry([s.fake.runner]);
    const pool = createManagerPool({
      stores: s.stores,
      post: () => undefined,
      runners: reopened,
      profile: createProfileService({ stores: s.stores, runners: reopened }),
      tokenIdentity: () => ({ ...s.active }),
    });
    await pool.restore();
    s.fake.resumes.length = 0;
    s.fake.sends.length = 0;

    const result = await pool.send('mgr-stale', '続きを');

    expect(s.fake.stops).toHaveLength(0);
    expect(result.outcome).not.toBe('delivered');
    await pool.stop();
    await s.pool.stop();
  });

  it('畳めたと確かめられなければ resume しない（二重のセッションを作らない）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.stopIgnored = true;

    const result = await s.pool.send('mgr-stale', '続きを');

    expect(s.fake.stops).toEqual(['mgr-stale']);
    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('畳めた');
    await s.pool.stop();
  });

  it('manager_list の世代の ⚠ は、runner が最後に見た背景処理の本数を添える', async () => {
    const s = await setup();
    s.rotate();
    const summary = await summaryOf(s.pool);
    // 観測（10秒ごとの生存確認）はこの偽 runner では走らないので、欄は無い。
    expect(summary.liveBackgroundTasks).toBeUndefined();
    await s.pool.stop();
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
