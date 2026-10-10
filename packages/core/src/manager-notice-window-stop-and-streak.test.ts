import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

// 知らせの合流窓（#4443 の枠の一斉停止・器の作り直し）の穴を測る: 連鎖で握りつぶした束が窓を開けて一覧に「先に届けてある」と載ること、窓を閉じて台帳を読んでいる最中の stop() が一覧を待たずに返ること。
// 「届く」ことは固定の待ちではなく `vi.waitFor` で、条件が満ちるまで待つ（CI の負荷で実時間が伸びても結果が変わらない）。
// 「届かない」ことを確かめるのは、届くはずのものを待ち終えた直後（窓の中）か、窓が閉じた後の固定の待ち。
// プール窓は、負荷で数百 ms 遅れても「窓の中」のまま確かめられるよう、担当ごとの窓（20ms）の100倍にしてある。
const NOTICE_WINDOW_MS = 20;
const POOL_WINDOW_MS = 2_000;
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

const SESSION_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
  /** 立ち上げ（reattach）の知らせより後の受信箱。 */
  fresh(): InboxEvent[];
}

async function setup(
  managerIds: readonly string[],
  opts: { poolMs?: number; wrapStores?: (s: Stores) => void } = {},
): Promise<Setup> {
  const stores = createMemoryStores();
  opts.wrapStores?.(stores);
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
    quotaStopWindowMs: opts.poolMs ?? POOL_WINDOW_MS,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length < managerIds.length) throw new Error('reattach の知らせがまだ届いていない');
  });
  const baseline = inbox.length;
  return { pool, stores, inbox, fake, fresh: () => inbox.slice(baseline) };
}

function quotaTurnFailed(
  fake: FakeRunner,
  managerId: string,
  limitText: string,
  status: JobStatus = 'done',
  said?: string,
): void {
  fake.emit({
    type: 'report',
    managerId,
    text:
      `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${limitText}` +
      (said === undefined ? '' : `\n\n（失敗する前に出ていた本文）\n${said}`),
    status,
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  });
}

function quotaClosedFailed(fake: FakeRunner, managerId: string, limitText: string): void {
  const at = fake.alive.findIndex((entry) => entry.managerId === managerId);
  if (at !== -1) fake.alive.splice(at, 1);
  fake.emit({
    type: 'closed',
    managerId,
    status: 'failed',
    reason: `マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${limitText}`,
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

function textOf(event: Extract<InboxEvent, { type: 'external' }>): string {
  return (event.payload as { text: string }).text;
}

type Fresh = () => InboxEvent[];

async function waitForOwn(fresh: Fresh, ids: readonly string[]): Promise<void> {
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

describe('知らせの合流窓: 連鎖で握りつぶす束と、デーモンの停止', () => {
  it('連鎖で握りつぶした束では枠の窓を開けない（一覧が、届けていない知らせを「先に届けてある」と言わない）', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b'], { poolMs: 300 });
    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT, 'running');
    await waitForOwn(fresh, ['mgr-a']);
    // 枠の窓（300ms）が A だけで閉じるのを待つ。
    await sleep(500);
    expect(externals(fresh())).toHaveLength(0);

    // 窓の外で A に同文が来る（連鎖で握りつぶす）。続けて B が来る。
    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT, 'running');
    quotaTurnFailed(fake, 'mgr-b', SESSION_LIMIT, 'running');
    // B は窓を開ける1本目として担当へすぐ届く。
    await vi.waitFor(
      () => expect(managerMessages(fresh()).filter((m) => m.managerId === 'mgr-b')).toHaveLength(1),
      WAIT,
    );
    await sleep(500);

    // A の2本目は担当へも届かず、一覧にも「先に届けてある」として載らない。
    expect(managerMessages(fresh()).filter((m) => m.managerId === 'mgr-a')).toHaveLength(1);
    for (const event of externals(fresh())) {
      expect(textOf(event)).not.toMatch(/- mgr-a:.*先に届けてある/);
    }
    await pool.stop();
  });

  it('窓が閉じて台帳を読んでいる最中に stop() が来ても、stop() は一覧を配り終えるまで待つ', async () => {
    let release: (() => void) | undefined;
    let armed = false;
    let called = false;
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b'], {
      poolMs: 100,
      wrapStores: (st) => {
        const orig = st.jobs.listJobs.bind(st.jobs);
        st.jobs.listJobs = async () => {
          if (armed) {
            called = true;
            await new Promise<void>((r) => (release = r));
          }
          return orig();
        };
      },
    });
    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT, 'running');
    await waitForOwn(fresh, ['mgr-a']);
    armed = true;
    quotaClosedFailed(fake, 'mgr-b', SESSION_LIMIT);
    await vi.waitFor(() => expect(called).toBe(true), WAIT);
    const stopping = pool.stop();
    setTimeout(() => release?.(), 300);
    await stopping;
    expect(externals(fresh()), 'stop() が返った時点で一覧は配られているはず').toHaveLength(1);
    release?.();
  });
});
