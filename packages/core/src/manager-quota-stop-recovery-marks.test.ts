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

// 枠だけが理由の知らせに、クローンが配る直前に「回復したか」を添えるための印（#4497）。
// 担当ごとの manager_message の `quotaStop` と、プール全体の1通の payload の `quotaStopManagerIds` を、外から観測する。
// 組み方は manager-quota-stop-notice.test.ts と同じ（窓の時間も同じ考え方: 届くものは waitFor で待ち、届かないことは窓の中で確かめる）。
const NOTICE_WINDOW_MS = 20;
const POOL_WINDOW_MS = 2_000;
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

const SESSION_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";

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

function quotaTurnFailed(fake: FakeRunner, managerId: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${SESSION_LIMIT}`,
    status: 'done',
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  });
}

function otherTurnFailed(fake: FakeRunner, managerId: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text: '（このターンは応答を返さずに終わった: error_during_execution / result_subtype）\n内部エラー',
    status: 'done',
    failure: { code: 'error_during_execution', via: 'result_subtype' },
    synthesized: 'turn_failed',
  });
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

describe('枠だけの知らせに回復を添えるための印（#4497）', () => {
  it('枠だけが理由の知らせは、担当ごとの manager_message に quotaStop: true が付いて届く', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    quotaTurnFailed(fake, 'mgr-a');
    await waitForOwn(fresh, ['mgr-a']);

    expect(managerMessages(fresh())[0]).toMatchObject({
      managerId: 'mgr-a',
      synthesized: true,
      quotaStop: true,
    });

    await pool.stop();
  });

  it('枠と無関係の落ち方の知らせには quotaStop のキーが無い', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    otherTurnFailed(fake, 'mgr-a');
    await waitForOwn(fresh, ['mgr-a']);

    const own = managerMessages(fresh())[0]!;
    expect(own.text).toContain('内部エラー');
    expect('quotaStop' in own).toBe(false);

    await pool.stop();
  });

  it('枠の断片と枠でない断片が同じ束に混ざる担当の知らせには quotaStop のキーが無い', async () => {
    const { pool, fake, fresh } = await setup(['mgr-mixed']);

    quotaTurnFailed(fake, 'mgr-mixed');
    fake.emit({
      type: 'closed',
      managerId: 'mgr-mixed',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: Error: spawn EAGAIN',
    });
    await waitForOwn(fresh, ['mgr-mixed']);

    const own = managerMessages(fresh())[0]!;
    expect(own.text).toContain('spawn EAGAIN');
    expect(own.text).toContain(SESSION_LIMIT);
    expect('quotaStop' in own).toBe(false);

    await pool.stop();
  });

  it('同じトークンで3本が枠に当たると、プール全体の1通の payload が、窓を開けた担当を含む全員の id を持つ', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    quotaTurnFailed(fake, 'mgr-a');
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b');
    quotaTurnFailed(fake, 'mgr-c');
    await vi.waitFor(() => expect(externals(fresh())).toHaveLength(1), WAIT);

    const sent = externals(fresh())[0]!;
    expect(sent.source).toBe('runner-registry');
    const payload = sent.payload as { text: string; quotaStopManagerIds: string[] };
    expect([...payload.quotaStopManagerIds].sort()).toEqual(['mgr-a', 'mgr-b', 'mgr-c']);
    expect(payload.text).toContain('枠に当たって 3 本の担当が止まった');

    await pool.stop();
  });
});
