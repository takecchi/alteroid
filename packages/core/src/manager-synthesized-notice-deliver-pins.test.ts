import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

// 機構が合成した知らせの「段2」（担当ごとの短い窓で束ねて配る部分）を、公開の口と runner の出来事だけで縛る。
// 段2を別のクラスへ切り出しても同じ試験が通ること。時計は偽の時計で、実時間の待ちは使わない。
const NOTICE_WINDOW_MS = 20;

interface FakeRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  emit(event: RunnerEvent): void;
}

function fakeRunner(): FakeRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return { runner, alive, emit: (event) => emit?.(event) };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
}

async function setup(ids: readonly string[]): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  for (const id of ids) {
    const job: Job = {
      id,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-primary',
    };
    await stores.jobs.putJob(job);
    fake.alive.push({
      liveBackgroundTasks: 0,
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: job.sessionId,
    });
  }
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    synthesizedNoticeWindowMs: NOTICE_WINDOW_MS,
  });
  await pool.restore();
  await settle();
  // 立ち上げ（reattach）の知らせは数えない。
  inbox.length = 0;
  return { pool, stores, inbox, fake };
}

/** 偽の時計を進めて、積まれた非同期の処理を流す。 */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

type Message = Extract<InboxEvent, { type: 'manager_message' }>;

function messages(events: readonly InboxEvent[]): Message[] {
  return events.filter((event): event is Message => event.type === 'manager_message');
}

function turnFailed(fake: FakeRunner, managerId: string, text: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text,
    status: 'running',
    failure: { code: 'crash', via: 'result_is_error' },
    synthesized: 'turn_failed',
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('畳めない出来事が来たときの配る順（#emit は先に全担当の窓を流してから本題を配る）', () => {
  it('2つの担当の知らせを同じ時刻に積んでから question が来ると、積んだ順に2通配ってから question が届き、窓のタイマーは残らない', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a', 'mgr-b']);

    turnFailed(fake, 'mgr-a', '（このターンは応答を返さずに終わった: crash / A）');
    turnFailed(fake, 'mgr-b', '（このターンは応答を返さずに終わった: crash / B）');
    // 出来事の処理は非同期なので、積み終えるまで時計を進めずに流す（窓はまだ閉じない）。
    await settle();
    expect(messages(inbox)).toHaveLength(0);
    fake.emit({
      type: 'ask',
      managerId: 'mgr-a',
      requestId: 'req-1',
      kind: 'question',
      summary: 'これでよいか',
      askedAt: '2026-10-01T00:00:00.000Z',
    });
    await settle();

    // 窓（20ms）が閉じる前に、question が積みを押し出している。
    expect(messages(inbox).map((m) => [m.managerId, m.kind])).toEqual([
      ['mgr-a', 'report'],
      ['mgr-b', 'report'],
      ['mgr-a', 'question'],
    ]);
    expect(messages(inbox)[0]?.text).toBe('（このターンは応答を返さずに終わった: crash / A）');
    expect(messages(inbox)[1]?.text).toBe('（このターンは応答を返さずに終わった: crash / B）');

    // 押し出された窓のタイマーは解いてある: 窓の長さを過ぎても、同じ知らせが二度配られない。
    await settle(NOTICE_WINDOW_MS * 5);
    expect(messages(inbox)).toHaveLength(3);
    await pool.stop();
    expect(messages(inbox)).toHaveLength(3);
  });
});
