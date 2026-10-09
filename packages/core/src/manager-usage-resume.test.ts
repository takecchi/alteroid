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
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const JOB: Job = {
  id: 'mgr-usage',
  managerId: 'mgr-usage',
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function nudgeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const behavior: { sendMode: 'ok' | 'throw' } = { sendMode: 'ok' };
  const transcripts = new Map<string, string | null>();

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
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
      if (behavior.sendMode === 'throw') {
        throw new Error('この検証が仕込んだ送信エラー（空振りを作るための細工）');
      }
      sends.push({ managerId, text });
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      // 一覧から消さない: `abort()` が「止まったと確かめられない」側へ落ち、台帳が `stopped` にならないから。
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async transcript(managerId: string) {
      return transcripts.get(managerId) ?? null;
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
    behavior,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
    setTranscript(managerId: string, body: string | null): void {
      transcripts.set(managerId, body);
    },
  };
}

async function setup() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = nudgeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return { pool, fake, stores, inbox };
}

async function reopen(stores: Stores) {
  const fake = nudgeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  await pool.restore();
  // 控えを払う: `running` で残ったジョブは起動時の引き取りで無条件に resume されるので、枠の印による resume と区別できなくなる。
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return { pool, fake, stores, inbox };
}

function reached(): RunnerEvent {
  return {
    type: 'usage_notice',
    managerId: 'mgr-usage',
    notice: { kind: 'reached', text: "You've hit your individual spend limit for this account." },
  } as RunnerEvent;
}

function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: 'mgr-usage',
    text: "[failed] You've hit your individual spend limit for this account.",
    status: 'done',
    failure: { code: 'usage_limit', via: 'result' },
  } as RunnerEvent;
}

function okReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: 'mgr-usage',
    text: '調べ終えた',
    status: 'done',
  } as RunnerEvent;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setupWithClock() {
  let clock = Date.now();
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = nudgeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock,
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return {
    pool,
    fake,
    stores,
    inbox,
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

function turnEndLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp,
    message: {
      role: 'assistant',
      id: 'msg_settle_probe',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  });
}

const PAST_QUIET_GATE_MS = 11 * 60_000;

describe('枠で止まった委譲を、鍵が通る状態へ戻った時点で続きから起こす', () => {
  it('枠でターンが死んだ委譲へ、続きを促す一言が生きたセッションへ届く（新しいセッションを開かない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
    expect(s.fake.sends[0]?.text).toContain('最初からやり直さないこと');
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('セッションごと落ちていた（failed）委譲は、同じ sessionId の resume で続きへ戻す', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push({
      type: 'closed',
      managerId: 'mgr-usage',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: usage limit',
    } as RunnerEvent);
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s.fake.resumes[0]?.message).toContain('通る鍵に戻った');
  });

  it('⚠️ 自力でターンを終えた委譲は起こさない（`reached` が来ていても、失敗で終わっていなければ印は下りる）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(okReport());
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('枠に当たっていない委譲は起こさない（印そのものが立たない）', async () => {
    const s = await setup();
    s.fake.push({
      type: 'usage_notice',
      managerId: 'mgr-usage',
      notice: { kind: 'transition', text: "You're now using extra usage until your limit resets." },
    } as RunnerEvent);
    s.fake.push(failedReport());
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 人間・クローンが止めた委譲は甦らせず、印も永久には残らない（R4。判断は日誌に残る）', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();
    await s.pool.abort('mgr-usage');
    s.fake.sends.length = 0;
    s.fake.resumes.length = 0;

    const beforeAbortResume = await s.stores.jobs.listJobs();
    expect(beforeAbortResume[0]?.usageStoppedAt).toBeDefined();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    const jobs = await s.stores.jobs.listJobs();
    expect(jobs[0]?.status).toBe('stopped');
    expect(jobs[0]?.usageStoppedAt).toBeUndefined();
    const entries = await s.stores.journal.list({ limit: 200 });
    expect(
      entries.some(
        (entry) =>
          entry.type === 'decision' &&
          entry.decision.includes('この委譲は起こし直さない') &&
          entry.decision.includes('status=stopped'),
      ),
    ).toBe(true);
  });

  it('⭐ 起こしに行った時点でまだ走っていたら、そのターンが枠で終わった時点で起こす', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    s.fake.push(failedReport());
    await settle();

    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
  });

  it('⭐ 走っている最中に鍵が回っていれば、その後で枠に落ちた時点で起こす', async () => {
    const s = await setup();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(s.fake.sends).toHaveLength(1);
  });

  it('⚠️ 鍵が戻ったと誰も言っていないなら、枠で終わっても起こさない（勝手に挑み直さない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(s.fake.sends).toHaveLength(0);
    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
  });

  it('⚠️ 鍵が回った時点で走っていても、そのターンが自力で終わったなら起こさない（1ターン焼かない）', async () => {
    const s = await setup();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    s.fake.push(okReport());
    await settle();

    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('⭐ 走っている最中に鍵が回り、その後セッションごと枠で落ちた回も起こす（report が出ない道）', async () => {
    const s = await setup();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    s.fake.push(reached());
    s.fake.push({
      type: 'closed',
      managerId: 'mgr-usage',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: usage limit',
    } as RunnerEvent);
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
  });

  it('⚠️ 陰性対照: 届いた回はこれまでどおり1回きり（`nudged` は印を下ろすので、二度目の回転で二重に投げない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(1);
  });

  it('⭐ 空振りしても印が残り、次の回転で起こされる（`skipped` は下ろさない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    s.fake.behavior.sendMode = 'throw';
    const first = await s.pool.resumeStoppedByUsage();
    expect(first).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);

    const mid = await s.stores.jobs.listJobs();
    expect(mid[0]?.usageStoppedAt).toBeDefined();

    s.fake.behavior.sendMode = 'ok';
    const second = await s.pool.resumeStoppedByUsage();
    expect(second).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();
  });

  it('⭐ 空振りの後にデーモンが入れ替わっても、写しが残っているので新しい Pool が起こす', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    s.fake.behavior.sendMode = 'throw';
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s2.fake.resumes).toHaveLength(1);
    expect(s2.fake.resumes[0]?.sessionId).toBe('sess-1');
  });
});

describe('枠で止まった印を台帳へ持たせ、デーモンの入れ替わりを跨いで起こす（Issue #914 段2）', () => {
  it('入れ替わりを跨いで起こす: 台帳に usageStoppedAt が立ち、新しい Pool（status=done）がそれを読んで起こす', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    const before = await s.stores.jobs.listJobs();
    expect(before[0]?.status).toBe('done');
    expect(before[0]?.usageStoppedAt).toBeDefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s2.fake.resumes).toHaveLength(1);
    expect(s2.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s2.fake.resumes[0]?.message).toContain('通る鍵に戻った');
  });

  it('入れ替わりを跨いで起こす: status=lost で座っている分も拾える（#restoreJobs の continue を跨ぐ）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push({
      type: 'resume_failed',
      managerId: 'mgr-usage',
      sessionId: 'sess-1',
      reason: '前のセッションが見つからなかった',
      recovered: false,
    } as RunnerEvent);
    await settle();

    const stuck = await s.stores.jobs.listJobs();
    expect(stuck[0]?.status).toBe('lost');
    await s.stores.jobs.putJob({ ...stuck[0]!, usageStoppedAt: '2026-09-10T00:00:00.000Z' });

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s2.fake.resumes).toHaveLength(1);
    expect(s2.fake.resumes[0]?.sessionId).toBe('sess-1');
  });

  it('⚠️ 陰性対照: 印の無い委譲は、入れ替わりの後も起こされない（枠以外で落ちた委譲を起こさない）', async () => {
    const s = await setup();
    s.fake.push({
      type: 'closed',
      managerId: 'mgr-usage',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: 何か別の理由',
    } as RunnerEvent);
    await settle();

    const before = await s.stores.jobs.listJobs();
    expect(before[0]?.status).toBe('failed');
    expect(before[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 自力でターンを終えた委譲は、台帳からも印が消える', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(okReport());
    await settle();

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('一度起こしたら、入れ替わりの後に二度は起こさない', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('resume_failed（recovered: false）で帳簿が畳まれる: 台帳の印が消え、新しい Pool はもう起こさない', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();
    const stopped = await s.stores.jobs.listJobs();
    expect(stopped[0]?.usageStoppedAt).toBeDefined();

    s.fake.push({
      type: 'resume_failed',
      managerId: 'mgr-usage',
      sessionId: 'sess-1',
      reason: '前のセッションが見つからなかった',
      recovered: false,
    } as RunnerEvent);
    await settle();

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('lost');
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('対照: resume_failed（recovered: true）では印を落とさない（新しいセッションのターンが枠で終われば、まだ起こす対象）', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();

    s.fake.push({
      type: 'resume_failed',
      managerId: 'mgr-usage',
      sessionId: 'sess-1',
      reason: '前のセッションが見つからなかったが、新しいセッションで開けた',
      recovered: true,
    } as RunnerEvent);
    await settle();

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.usageStoppedAt).toBeDefined();
  });
});

describe('ManagerPool#settleStalledUsageWakes — report/closed を二度と出さないまま固まった借りを清算する（Issue #914 最終段）', () => {
  it('⭐ 4条件が揃うと一言が届く。record.job.status は書き換えない（stopped/lost に落ちない）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('ここでターンが枠の壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();

    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBe('2026-09-07T02:00:00.000Z');
    expect(probed?.status).toBe('running');
    const before = await s.stores.jobs.listJobs();
    expect(before[0]?.lastReportAt).toBeUndefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
    expect(s.fake.resumes).toHaveLength(0);

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.usageStoppedAt).toBeUndefined();
  });

  it('⚠️ 陰性対照: turnEndedAt が無ければ発火しない（「分からない」を症状へ倒さない）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBeUndefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.usageStoppedAt).toBeDefined();
  });

  it('⚠️ 陰性対照: turnEndedAt が lastReportAt 以前なら発火しない（報告は届いている）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    s.fake.push({
      type: 'report',
      managerId: 'mgr-usage',
      text: '進捗の途中経過（まだ続く）',
      status: 'running',
      failure: { code: 'usage_limit', via: 'result' },
    } as RunnerEvent);
    await settle();

    const midJobs = await s.stores.jobs.listJobs();
    const lastReportAt = midJobs[0]?.lastReportAt;
    expect(lastReportAt).toBeDefined();
    expect(s.fake.sends).toHaveLength(0);

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    const before = new Date(Date.parse(lastReportAt!) - 60_000).toISOString();
    s.fake.setTranscript('mgr-usage', turnEndLine('まだ届いていた頃のテール', before));
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();

    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBe(before);

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 借りが立っていなければ発火しない（鍵が戻ったと誰も言っていない）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();
    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBeDefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 枠の印（usageStopped）が無ければ発火しない（枠以外の理由で長く走っている委譲を掃かない）', async () => {
    const s = await setupWithClock();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('枠以外の理由で長く働いているだけ', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();
    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBeDefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: waiting_human は起こさない（待っているのは枠ではなく人間の回答である）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    // `turnEndedAt` は running のうちに立てる: `probeTurnEnds()` は `status === 'running'` しか引かず、`waiting_human` になった後では立てられないから。
    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();
    const probedBefore = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probedBefore?.turnEndedAt).toBeDefined();

    s.fake.push({
      type: 'ask',
      managerId: 'mgr-usage',
      requestId: 'req-1',
      kind: 'question',
      summary: '続けてよいか確認したい',
    } as RunnerEvent);
    await settle();
    const waiting = await s.stores.jobs.listJobs();
    expect(waiting[0]?.status).toBe('waiting_human');

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('空振り（send() が届かない）のとき、借りは下りるが印は残る（次の鍵の回転が拾い直す）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();

    s.fake.behavior.sendMode = 'throw';
    const first = await s.pool.settleStalledUsageWakes();

    expect(first).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    const mid = await s.stores.jobs.listJobs();
    expect(mid[0]?.usageStoppedAt).toBeDefined();
    expect(mid[0]?.status).toBe('running');

    const again = await s.pool.settleStalledUsageWakes();
    expect(again).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    s.fake.behavior.sendMode = 'ok';
    const recovered = await s.pool.settleStalledUsageWakes();

    expect(recovered).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();
  });
});
