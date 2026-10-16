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

// 日誌の decision のうち、本文が「届けずに断った」の行と、畳みの要約の行を数える。
async function declineCounts(s: Setup): Promise<{ original: number; summaries: string[] }> {
  const decisions = await s.stores.journal.list({ types: ['decision'] });
  const texts = decisions.map((entry) => JSON.stringify(entry));
  const summaries = texts.filter(
    (text) => text.includes('届けずに断った') && text.includes('同じ合図が続いたので畳んだ'),
  );
  const original = texts.filter(
    (text) => text.includes('届けずに断った') && !text.includes('同じ合図が続いたので畳んだ'),
  );
  return { original: original.length, summaries };
}

describe('古い鍵の done へ本文を断った decision を日誌で畳む（#4982）', () => {
  it('⭐ 預かりの届け直しが見回りごとに断られても、「届けずに断った」の decision は最初の1行だけで、残りは畳む', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 5);

    const counts = await declineCounts(s);
    expect(counts.original).toBe(1);
    expect(counts.summaries).toHaveLength(0);
    await s.pool.stop();
  });

  it('理由が変わると、その場で畳んだ件数の要約1行と新しい本文の1行が出る', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 3);
    expect((await declineCounts(s)).original).toBe(1);

    // 本数が分からない状態から、背景処理が1本残っている状態へ変える（断る理由の文が変わる）
    s.fake.behavior.background = 1;
    await poll(s, 1);

    const counts = await declineCounts(s);
    expect(counts.original).toBe(2);
    expect(counts.summaries).toHaveLength(1);
    expect(counts.summaries[0]).toContain('2回目以降を 3 回ぶん');
    await s.pool.stop();
  });

  it('届けられるようになって預かりが届いた時点で、畳み残しの要約が1行出る', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 4);
    expect((await declineCounts(s)).summaries).toHaveLength(0);

    s.fake.behavior.background = 0;
    await poll(s, 1);

    const counts = await declineCounts(s);
    expect(counts.original).toBe(1);
    expect(counts.summaries).toHaveLength(1);
    expect(counts.summaries[0]).toContain('2回目以降を 4 回ぶん');
    const delivered = (await s.stores.journal.list({ types: ['decision'] })).filter((entry) =>
      JSON.stringify(entry).includes('預かっていた伝言 1 通を届けた'),
    );
    expect(delivered).toHaveLength(1);
    await s.pool.stop();
  });

  it('期限で預かりを捨てた時点でも、畳み残しの要約が1行出る', async () => {
    const s = await setup();

    expect((await s.pool.send('mgr-fold', '続きをお願い')).outcome).toBe('held');
    await poll(s, 3);

    s.clock.now += HELD_MESSAGE_TTL_MS;
    await s.pool.deliverHeldMessages?.();

    const counts = await declineCounts(s);
    expect(counts.original).toBe(1);
    expect(counts.summaries).toHaveLength(1);
    expect(counts.summaries[0]).toContain('2回目以降を 3 回ぶん');
    const released = (await s.stores.journal.list({ types: ['decision'] })).filter((entry) =>
      JSON.stringify(entry).includes('届けずに捨てた'),
    );
    expect(released).toHaveLength(1);
    await s.pool.stop();
  });
});
