import { describe, expect, it } from 'vitest';

import { createManagerPool, HELD_MESSAGE_TTL_MS } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

const JOB: Job = {
  id: 'mgr-fold',
  managerId: 'mgr-fold',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const MINUTE_MS = 60_000;

// 背景処理の本数を後から変えられる偽の runner（`manager-send-held.test.ts` と同じ形）。`background` を undefined にすると本数を返さない古い runner になる。
function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const behavior: { background: number | undefined } = { background: undefined };

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
        waiting: [],
        ...(behavior.background === undefined ? {} : { liveBackgroundTasks: behavior.background }),
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

async function setup() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const active = { tokenId: 'tok-a', generation: 59 };
  const clock = { now: Date.parse('2026-10-11T02:00:00.000Z') };
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ ...active }),
    now: () => clock.now,
  });
  await pool.restore();
  fake.push({
    type: 'report',
    managerId: 'mgr-fold',
    text: '終わった',
    status: 'done',
  } as RunnerEvent);
  await settle();
  // 世代を食い違わせる（抱えている世代 59、現役 60）
  active.tokenId = 'tok-b';
  active.generation = 60;
  return { pool, fake, stores, clock, inbox };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function poll(s: Setup, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    s.clock.now += MINUTE_MS;
    await s.pool.deliverHeldMessages?.();
  }
}

// 日誌の decision のうち、本文が「届けずに断った」の行を数える。
async function declineLines(s: Setup): Promise<number> {
  const decisions = await s.stores.journal.list({ types: ['decision'] });
  return decisions.filter((entry) => JSON.stringify(entry).includes('届けずに断った')).length;
}

describe('見回りの届け直しが同じ判定で断るだけの回は、断りの decision を書き直さない（#4982）', () => {
  it('⭐ 同じ理由の見回りの再判定を何回まわしても、「届けずに断った」の decision は最初の1行のまま増えない', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 5);

    expect(await declineLines(s)).toBe(1);
    // decision の行は畳まない（#1311）: 要約の行も作らない
    const decisions = await s.stores.journal.list({ types: ['decision'] });
    expect(decisions.some((entry) => JSON.stringify(entry).includes('畳んだ'))).toBe(false);
    await s.pool.stop();
  });

  it('⭐ 理由が変わると1行増え、変わった理由のまま見回りを続けても、それ以上は増えない', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 3);
    expect(await declineLines(s)).toBe(1);

    // 本数が分からない状態から、背景処理が1本残っている状態へ変える（断る理由の文が変わる）
    s.fake.behavior.background = 1;
    await poll(s, 1);
    expect(await declineLines(s)).toBe(2);

    await poll(s, 3);
    expect(await declineLines(s)).toBe(2);
    await s.pool.stop();
  });

  it('⭐ 見回りの途中で人・クローンの manager_send が来て断られると、理由が同じでも1行書く', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 2);
    expect(await declineLines(s)).toBe(1);

    // 預かりの列の後ろに並び、その場で届け直しを試して同じ理由で断られる
    expect((await s.pool.send('mgr-fold', 'もう一つお願い')).outcome).toBe('held');
    expect(await declineLines(s)).toBe(2);

    await poll(s, 2);
    expect(await declineLines(s)).toBe(2);
    await s.pool.stop();
  });

  it('届けられるようになれば、断りの行は増えずに「届けた」の行が出る', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 2);
    s.fake.behavior.background = 0;
    await poll(s, 1);
    const delivered = (await s.stores.journal.list({ types: ['decision'] })).filter((entry) =>
      JSON.stringify(entry).includes('預かっていた伝言 1 通を届けた'),
    );
    expect(delivered).toHaveLength(1);
    expect(await declineLines(s)).toBe(1);
    await s.pool.stop();
  });

  it('期限で預かりを捨てるまで見回りを続けても、断りの行は最初の1行のまま', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 3);

    s.clock.now += HELD_MESSAGE_TTL_MS;
    await s.pool.deliverHeldMessages?.();

    expect(await declineLines(s)).toBe(1);
    const released = (await s.stores.journal.list({ types: ['decision'] })).filter((entry) =>
      JSON.stringify(entry).includes('届けずに捨てた'),
    );
    expect(released).toHaveLength(1);
    await s.pool.stop();
  });
});
