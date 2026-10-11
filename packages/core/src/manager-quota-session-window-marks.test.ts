import { describe, expect, it, vi } from 'vitest';

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

// 枠の知らせが5時間枠（session）だけのとき、担当ごとの manager_message と、プール全体の1通の payload に付く印（#4499）を外から観測する。
// 組み方は manager-quota-stop-recovery-marks.test.ts と同じ（届くものは waitFor で待ち、届かないことは窓の中で確かめる）。
const NOTICE_WINDOW_MS = 20;
const POOL_WINDOW_MS = 2_000;
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

const SESSION_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";
const WEEKLY_LIMIT = "You've hit your weekly limit · resets Oct 14, 9am (Asia/Tokyo)";

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
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
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
  fake: FakeRunner;
  /** 立ち上げ（reattach）の知らせより後の受信箱。 */
  fresh(): InboxEvent[];
}

async function setup(managerIds: readonly string[]): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  for (const id of managerIds) {
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
    quotaStopWindowMs: POOL_WINDOW_MS,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length < managerIds.length) throw new Error('reattach の知らせがまだ届いていない');
  });
  const baseline = inbox.length;
  return { pool, fake, fresh: () => inbox.slice(baseline) };
}

function quotaTurnFailed(fake: FakeRunner, managerId: string, limit = SESSION_LIMIT): void {
  fake.emit({
    type: 'report',
    managerId,
    text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${limit}`,
    status: 'done',
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  });
}

function rateLimited(fake: FakeRunner, managerId: string, kind: string): void {
  fake.emit({ type: 'rate_limit', managerId, facts: { status: 'rejected', kind } });
}

function externals(events: readonly InboxEvent[]) {
  return events.filter((event) => event.type === 'external') as Extract<
    InboxEvent,
    { type: 'external' }
  >[];
}

function managerMessages(events: readonly InboxEvent[]) {
  return events.filter((event) => event.type === 'manager_message') as Extract<
    InboxEvent,
    { type: 'manager_message' }
  >[];
}

async function waitForOwn(fresh: () => InboxEvent[], ids: readonly string[]): Promise<void> {
  await vi.waitFor(
    () =>
      expect(
        managerMessages(fresh())
          .map((m) => m.managerId)
          .sort(),
      ).toEqual([...ids].sort()),
    WAIT,
  );
}

describe('枠の知らせの5時間枠の印（#4499）', () => {
  it('5時間枠（session limit）の文言の枠の知らせは、manager_message に quotaStop: true と quotaSessionWindow: true が付く', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    quotaTurnFailed(fake, 'mgr-a');
    await waitForOwn(fresh, ['mgr-a']);

    expect(managerMessages(fresh())[0]).toMatchObject({
      quotaStop: true,
      quotaSessionWindow: true,
    });

    await pool.stop();
  });

  it('週の上限の文言の枠の知らせは quotaStop: true だけが付き、quotaSessionWindow のキーが無い', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    quotaTurnFailed(fake, 'mgr-a', WEEKLY_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);

    const own = managerMessages(fresh())[0]!;
    expect(own.text).toContain('weekly limit');
    expect(own.quotaStop).toBe(true);
    expect('quotaSessionWindow' in own).toBe(false);

    await pool.stop();
  });

  it('プール全体の1通は、全員が session なら payload に quotaSessionWindow: true を持つ', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    quotaTurnFailed(fake, 'mgr-a');
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b');
    quotaTurnFailed(fake, 'mgr-c');
    await vi.waitFor(() => expect(externals(fresh())).toHaveLength(1), WAIT);

    const payload = externals(fresh())[0]!.payload as Record<string, unknown>;
    expect(payload.quotaSessionWindow).toBe(true);
    expect((payload.quotaStopManagerIds as string[]).length).toBe(3);

    await pool.stop();
  });

  it('プール全体の1通は、1本でも weekly が混ざれば payload に quotaSessionWindow のキーが無い', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    quotaTurnFailed(fake, 'mgr-a');
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b', WEEKLY_LIMIT);
    quotaTurnFailed(fake, 'mgr-c');
    await vi.waitFor(() => expect(externals(fresh())).toHaveLength(1), WAIT);

    const payload = externals(fresh())[0]!.payload as Record<string, unknown>;
    expect((payload.quotaStopManagerIds as string[]).length).toBe(3);
    expect('quotaSessionWindow' in payload).toBe(false);

    await pool.stop();
  });

  it("rate_limit の facts が kind: 'five_hour' なら quotaSessionWindow: true が付く", async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    rateLimited(fake, 'mgr-a', 'five_hour');
    await waitForOwn(fresh, ['mgr-a']);

    expect(managerMessages(fresh())[0]).toMatchObject({
      quotaStop: true,
      quotaSessionWindow: true,
    });

    await pool.stop();
  });

  it("rate_limit の facts が kind: 'seven_day' なら quotaStop は付くが quotaSessionWindow のキーが無い", async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    rateLimited(fake, 'mgr-a', 'seven_day');
    await waitForOwn(fresh, ['mgr-a']);

    const own = managerMessages(fresh())[0]!;
    expect(own.quotaStop).toBe(true);
    expect('quotaSessionWindow' in own).toBe(false);

    await pool.stop();
  });
});
