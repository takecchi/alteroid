import { describe, expect, it } from 'vitest';

import {
  HELD_FORCE_FOLD_AFTER_MS,
  composePeerCloseNotices,
  createManagerPool,
  remainingFoldNotice,
  type ManagerPoolOptions,
} from './manager.js';
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
    peers: number | undefined;
    commands: string[] | undefined;
    waiting: RunnerManagerState['waiting'];
    // 起こし直しの送信の途中（resume の await の間）に走らせる処理
    onResume: (() => void) | undefined;
  } = { background: 0, peers: undefined, commands: undefined, waiting: [], onResume: undefined };

  const stateOf = (base: RunnerManagerState): RunnerManagerState => ({
    ...base,
    waiting: behavior.waiting,
    ...(behavior.background === 'absent' ? {} : { liveBackgroundTasks: behavior.background }),
    ...(behavior.peers === undefined ? {} : { liveBackgroundPeers: behavior.peers }),
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
      behavior.onResume?.();
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

  it('⭐ (a3) 背景の peer 1 本と作業者の背景処理 1 本: 畳んだのは作業者の分だけと数え、peer は続いている・やり直さないと別に書く（#4881）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 2;
    s.fake.behavior.peers = 1;

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-fold']);

    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('背景処理 1 本をセッションごと畳んで');
    expect(message).not.toContain('背景処理 2 本');
    expect(message).toContain('peer 1 本は畳まずに預けてあり、まだ続いている');
    expect(message).toContain('やり直さないこと');
    await s.pool.stop();
  });

  it('⭐ (a4) 背景の peer だけのときは、「畳んだ・結果は届いていない」を出さず、続いている・やり直さないとだけ書く（#4881）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.behavior.background = 1;
    s.fake.behavior.peers = 1;

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-fold']);

    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('peer 1 本は畳まずに預けてあり、まだ続いている');
    expect(message).toContain('やり直さないこと');
    expect(message).not.toContain('結果は届いていない');
    expect(message).not.toContain('起こしっぱなしだった背景処理');
    await s.pool.stop();
  });

  it('⭐ (a5) 預けた peer が期限で閉じられていたら、閉じた peer と途中で終わった背景ターンを起こし直しの文の先頭へ添え、届いたら下ろす（#4885）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.push({
      type: 'parked_peers_closed',
      managerId: 'mgr-fold',
      reason: 'expired',
      peers: [
        { id: 'peer-aaa', provider: 'codex', interrupted: '調査の途中で止まった' },
        { id: 'peer-bbb', provider: 'codex' },
      ],
    });
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.pendingPeerCloseNotice?.peers).toHaveLength(2);

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-fold']);

    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('預けていた peer 2 本を閉じた');
    expect(message).toContain('codex[peer-aaa]');
    expect(message).toContain(
      '走っていた背景ターンは途中で終わった: codex[peer-aaa] 調査の途中で止まった',
    );
    expect(message).toContain('peer_run で新しく頼むこと');
    expect(message.indexOf('預けていた peer')).toBeLessThan(message.indexOf('認証トークン'));
    // 届いた回で下ろす: 二度添えない
    expect((await s.stores.jobs.listJobs())[0]?.pendingPeerCloseNotice).toBeUndefined();
    await s.pool.stop();
  });

  it('(a6) 背景ターンの無い peer だけでも、閉じたことは添える（途中で終わった背景ターンの節は出さない。#4885）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.push({
      type: 'parked_peers_closed',
      managerId: 'mgr-fold',
      reason: 'shutdown',
      peers: [{ id: 'peer-ccc', provider: 'codex' }],
    });
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-fold']);

    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('預けていた peer 1 本を閉じた');
    expect(message).not.toContain('途中で終わった');
    await s.pool.stop();
  });

  it('⭐ (a5b) 送信の途中で届いた parked_peers_closed は、配達が成功しても残り、次の起こし直しに添える。理由の違う知らせは混ざらない（#4899）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.push({
      type: 'parked_peers_closed',
      managerId: 'mgr-fold',
      reason: 'expired',
      peers: [{ id: 'peer-early', provider: 'codex' }],
    });
    await settle();
    // 配達の途中（resume の await の間）に、理由の違う知らせが届く
    s.fake.behavior.onResume = () => {
      s.fake.push({
        type: 'parked_peers_closed',
        managerId: 'mgr-fold',
        reason: 'shutdown',
        peers: [{ id: 'peer-late', provider: 'codex' }],
      });
    };

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-fold']);
    s.fake.behavior.onResume = undefined;
    await settle();

    const first = s.fake.resumes[0]?.message ?? '';
    expect(first).toContain('codex[peer-early]');
    expect(first).not.toContain('peer-late');
    // 後から届いた分は消えず、理由も上書きされない
    const left = (await s.stores.jobs.listJobs())[0]?.pendingPeerCloseNotice;
    expect(left?.peers).toEqual([{ id: 'peer-late', provider: 'codex', reason: 'shutdown' }]);
    expect(left?.reason).toBe('shutdown');
    await s.pool.stop();
  });

  it('(a5c) 理由の違う peer が積まれていたら、理由ごとに別の文面にして、peer と理由の対応を保つ。古い形（peer に理由が無い）も読める（#4899）', () => {
    const text = composePeerCloseNotices({
      reason: 'shutdown',
      peers: [
        { id: 'p1', provider: 'codex', reason: 'expired' },
        { id: 'p2', provider: 'codex', reason: 'shutdown' },
        { id: 'p3', provider: 'codex' },
      ],
    });
    const parts = text.split('\n\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('預かりの期限が来た');
    expect(parts[0]).toContain('codex[p1]');
    expect(parts[0]).not.toContain('p2');
    expect(parts[1]).toContain('器を畳んだ');
    expect(parts[1]).toContain('codex[p2], codex[p3]');
  });

  it('(a5d) 畳みの断り書きも、畳み込んだ分だけを引き、後から積まれた分を残す（#4899）', () => {
    const folded = {
      backgroundTasks: 1,
      peers: 1,
      commands: ['a'],
      at: '2026-10-15T03:00:00.000Z',
    };
    const current = {
      backgroundTasks: 3,
      peers: 1,
      commands: ['a', 'b'],
      at: '2026-10-15T03:00:01.000Z',
    };
    expect(remainingFoldNotice(current, folded)).toEqual({
      backgroundTasks: 2,
      commands: ['b'],
      at: '2026-10-15T03:00:01.000Z',
    });
    expect(remainingFoldNotice(folded, folded)).toBeUndefined();
    expect(remainingFoldNotice(current, undefined)).toBe(current);
  });

  it('(a7) 人が止めた場合は担当が起こされないので、台帳には預けない（クローンへの知らせだけ。#4885）', async () => {
    const s = await setup(async () => 'cooling');
    s.fake.push({
      type: 'parked_peers_closed',
      managerId: 'mgr-fold',
      reason: 'stopped',
      peers: [{ id: 'peer-ddd', provider: 'codex', interrupted: '途中' }],
    });
    await settle();

    expect((await s.stores.jobs.listJobs())[0]?.pendingPeerCloseNotice).toBeUndefined();
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
