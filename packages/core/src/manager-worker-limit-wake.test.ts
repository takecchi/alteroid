import { describe, expect, it, vi } from 'vitest';

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

// 作業者の落ちで手を止めた担当を、鍵の回転の後に起こす（#5030）。起こすのは担当の続きだけで、鍵の回転は起こさない（#4903）

const JOB: Job = {
  id: 'mgr-wl-wake',
  managerId: 'mgr-wl-wake',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const NUDGE_TEXT =
  '[system] 作業者が上限で落ちた鍵は回った（いまの現役は世代 279）。' +
  'この会話はそのまま続いている（最初からやり直さないこと）。' +
  '作業者を立て直して、止まっていた続きを進めてよい。';

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const delivered: string[] = [];

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
    async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
      delivered.push(command.message ?? '');
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
    async send(_managerId, text) {
      delivered.push(text);
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
    delivered,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
  };
}

// 起こさないことの確認用: 並行に走る処理を流し切る（待ち時間は置かない）
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setup(
  options: {
    availability?: ManagerPoolOptions['tokenAvailability'];
    status?: Job['status'];
  } = {},
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob({ ...JOB, status: options.status ?? 'running' });
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const observations: unknown[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ tokenId: 'tok-279', generation: 279 }),
    tokenAvailability: options.availability ?? (async () => 'ready'),
    onUsageObservation: async (observation) => {
      observations.push(observation);
    },
  });
  await pool.restore();
  // 起動時の組み直しが送った一言は、この検証の対象ではない
  fake.delivered.length = 0;
  return { pool, fake, stores, inbox, observations };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function workerLimitNote(preRotationKey: boolean): RunnerEvent {
  return {
    type: 'note',
    managerId: JOB.id,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    workerLimit: { raw: "You've hit your weekly limit", preRotationKey },
  } as RunnerEvent;
}

function doneReport(): RunnerEvent {
  return { type: 'report', managerId: JOB.id, text: '終わった', status: 'done' } as RunnerEvent;
}

async function wakeLines(s: Setup): Promise<string[]> {
  return (await s.stores.journal.list({ types: ['exchange'] }))
    .filter((e) => 'text' in e && e.text.includes('作業者の落ち'))
    .map((e) => ('text' in e ? e.text : ''));
}

describe('作業者の落ちで手を止めた担当を起こす（#5030）', () => {
  it('⭐ 回転前の鍵で落ち、担当が done で終わった。現役が ready なら専用の文で起こし、日誌に理由と世代を残す', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(true));
    s.fake.push(doneReport());

    await vi.waitFor(() => {
      expect(s.fake.delivered).toEqual([NUDGE_TEXT]);
    });
    const lines = await wakeLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('現役の世代 279');
    expect(JSON.stringify(s.fake.delivered)).not.toContain('tok-279');
    // 鍵の回転は起こさず、枠で止まった印も立てない
    expect(s.observations).toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });

  it('回転前の鍵で落ちても、現役が ready でなければ起こさない', async () => {
    const s = await setup({ availability: async () => 'cooling' });
    s.fake.push(workerLimitNote(true));
    s.fake.push(doneReport());
    await settle();

    expect(s.fake.delivered).toEqual([]);
    expect(await wakeLines(s)).toEqual([]);
    await s.pool.stop();
  });

  it('回転前の鍵で落ち、ターンの終わりに現役が ready でなかった印も、次の resumeStoppedByUsage で起こす（取り残さない）', async () => {
    const s = await setup({ availability: async () => 'cooling' });
    s.fake.push(workerLimitNote(true));
    s.fake.push(doneReport());
    await settle();
    expect(s.fake.delivered).toEqual([]);

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([JOB.id]);
    expect(s.fake.delivered).toEqual([NUDGE_TEXT]);
    expect(s.observations).toEqual([]);
    await s.pool.stop();
  });

  it('担当がまだ running のうちは起こさない（done で終わるまで待つ）', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(true));
    await settle();

    expect(s.fake.delivered).toEqual([]);
    await s.pool.resumeStoppedByUsage();
    expect(s.fake.delivered).toEqual([]);
    await s.pool.stop();
  });

  it('⭐ 現役の鍵で落ちた印は、done で終わっただけでは起こさず、次の resumeStoppedByUsage で起こす', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    s.fake.push(doneReport());
    await settle();
    expect(s.fake.delivered).toEqual([]);

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([JOB.id]);
    expect(s.fake.delivered).toEqual([NUDGE_TEXT]);
    expect(s.observations).toEqual([]);
    await s.pool.stop();
  });

  it('現役の鍵で落ちた印は、担当が running のままなら resumeStoppedByUsage でも起こさず、印を残す', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.delivered).toEqual([]);

    s.fake.push(doneReport());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([JOB.id]);
    await s.pool.stop();
  });

  it('担当がそのあと新しいターンを始めていたら、印を下ろして起こさない', async () => {
    const s = await setup({ availability: async () => 'cooling' });
    s.fake.push(workerLimitNote(false));
    s.fake.push(doneReport());
    await settle();
    // 人間・クローンが続きを送った: 新しいターンの始まり
    expect((await s.pool.send(JOB.id, '続きをお願い')).outcome).toBe('delivered');
    s.fake.delivered.length = 0;
    s.fake.push(doneReport());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.delivered).toEqual([]);
    await s.pool.stop();
  });

  it('後継へ引き継がれた担当は起こさない', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    s.fake.push({
      type: 'report',
      managerId: JOB.id,
      text: '落ちた',
      status: 'failed',
    } as RunnerEvent);
    await settle();
    // 後継を立てる経路（manager_start の supersedes）で前任を引き継ぐ
    await s.pool.start({ request: '引き継ぎ', cwd: '/work/project', supersedes: JOB.id });
    s.fake.delivered.length = 0;

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.delivered).toEqual([]);
    await s.pool.stop();
  });

  it('止められた担当は起こさない', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    s.fake.push(doneReport());
    await settle();
    await s.pool.abort(JOB.id, 'もう要らない');
    s.fake.delivered.length = 0;

    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.delivered).toEqual([]);
    await s.pool.stop();
  });

  it('⭐ 起こしたら印が下り、二度は起こさない', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    s.fake.push(doneReport());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual([JOB.id]);
    // 起こされた回が自力で終えた後の、次の回転
    s.fake.push(doneReport());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.delivered).toEqual([NUDGE_TEXT]);
    await s.pool.stop();
  });

  it('作業者の落ちの印は、枠で止まった担当ではない（usageStoppedAt を書かず、回転の観測へ流さない）', async () => {
    const s = await setup();
    s.fake.push(workerLimitNote(false));
    await settle();

    expect(s.observations).toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });
});
