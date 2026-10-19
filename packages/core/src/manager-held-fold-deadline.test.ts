import { describe, expect, it } from 'vitest';

import { HELD_FORCE_FOLD_AFTER_MS, createManagerPool } from './manager.js';
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

// 鍵が回った後、古い鍵（冷却中）と背景処理を抱えた done の担当へ送った伝言は預かりになる。
// 畳めない理由が背景処理だけなら、待ちの上限で背景処理ごと畳んで新しい鍵で起こし直し、届ける（#4472 / #5041）。
// その時刻を預かったときの返事で言う: 言わないと、呼び手はいつ届くか分からず、背景処理ごと捨てる manager_stop → manager_start を選ぶ
// （2026-10-19 に4回。PLAYTEST-6・E2E-FIX-1・HOUSE-18・LAND-10。どれも上限の前に手で止めた）

const JOB: Job = {
  id: 'mgr-held',
  managerId: 'mgr-held',
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T01:00:00.000Z',
  status: 'running',
  summary: '検証',
  request: '検証して',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const behavior: { background: number; waiting: RunnerManagerState['waiting'] } = {
    background: 0,
    waiting: [],
  };
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
      return alive.map((state) => ({
        ...state,
        waiting: behavior.waiting,
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
    resumes,
    behavior,
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

// 世代 328 の鍵で起こした担当がふつうに報告して done になり、背景処理を残したまま鍵が 329 へ回る（枠には当たっていない）
async function staleDoneWithBackground() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const active = { tokenId: 'tok-328', generation: 328 };
  const clock = { now: Date.parse('2026-10-19T12:28:30.000Z') };
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ ...active }),
    // 古い鍵は冷却中、現役の鍵は通る
    tokenAvailability: async (tokenId) => (tokenId === 'tok-329' ? 'ready' : 'cooling'),
    now: () => clock.now,
  });
  await pool.restore();
  fake.push({
    type: 'report',
    managerId: JOB.id,
    text: '検証を走らせた',
    status: 'done',
  } as RunnerEvent);
  await settle();
  fake.behavior.background = 1;
  fake.resumes.length = 0;
  active.tokenId = 'tok-329';
  active.generation = 329;
  return { pool, fake, clock };
}

describe('背景処理だけが理由で預かった伝言の返事に、遅くとも届ける時刻を書く', () => {
  it('⭐ 返事に「遅くとも <預かりから15分後>」と書き、manager_stop を今すぐ捨ててよい場合だけに位置づける', async () => {
    const s = await staleDoneWithBackground();

    const result = await s.pool.send(JOB.id, '続きを頼む');

    expect(result.outcome).toBe('held');
    const due = new Date(s.clock.now + HELD_FORCE_FOLD_AFTER_MS).toISOString();
    expect(result.detail).toContain(`遅くとも ${due}`);
    expect(result.detail).toContain('manager_stop も後継も要らない');
    expect(result.detail).toContain('今すぐ捨ててよい場合だけ');
    await s.pool.stop();
  });

  it('⭐ 書いた時刻を過ぎた見回りで、背景処理ごと畳んで新しい鍵で起こし直し、伝言を届ける', async () => {
    const s = await staleDoneWithBackground();
    await s.pool.send(JOB.id, '続きを頼む');

    // 上限の前の見回りでは畳まない
    s.clock.now += HELD_FORCE_FOLD_AFTER_MS - 60_000;
    await s.pool.deliverHeldMessages?.();
    expect(s.fake.resumes).toHaveLength(0);

    s.clock.now += 60_000;
    await s.pool.deliverHeldMessages?.();
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s.fake.resumes[0]?.message ?? '').toContain('続きを頼む');
    await s.pool.stop();
  });

  it('確認待ちも残っている（上限でも畳まない）回は、時刻を書かず、今までどおりの返事にする', async () => {
    const s = await staleDoneWithBackground();
    s.fake.behavior.waiting = [
      { requestId: 'req-1', kind: 'permission', summary: 'Bash の実行許可' },
    ] as RunnerManagerState['waiting'];

    const result = await s.pool.send(JOB.id, '続きを頼む');

    expect(result.outcome).toBe('held');
    expect(result.detail).not.toContain('遅くとも');
    expect(result.detail).toContain('残っている背景処理を捨ててよいなら manager_stop');
    await s.pool.stop();
  });
});
