import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

// 担当が器 B へ移った後に、古い器 A から遅れて届く rescue_ref（同じ relativePath）が、
// B が既に書いた項目を A の古い commit・ref・instanceId で置き換えてはならない。

const MANAGER_ID = 'mgr-moved-ref';
const ARCHIVE_ID = '0b5c6e1a-2f3d-4a7b-9c8d-1e2f3a4b5c6d';
const AT_B = '2026-10-12T02:00:00.000Z';
const AT_A = '2026-10-12T01:00:00.000Z';
const REF_B = 'refs/alteroid-rescue/mgr-moved-ref/root-bbbbbbbb';
const REF_A = 'refs/alteroid-rescue/mgr-moved-ref/root-aaaaaaaa';

function jobOf(): Job {
  return {
    id: MANAGER_ID,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    status: 'running',
    summary: '移った後',
    request: '退避して',
    cwd: '/work/project',
    sessionId: 'sess-moved',
    runnerId: 'runner-b',
  };
}

function fakeRunner(runnerId: string, instanceId: string, alive: RunnerManagerState[]) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const runner = {
    runnerId,
    runnerIdKnown: true,
    instanceId,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent: (event: RunnerEvent) => void) {
      emit = onEvent;
    },
    async start(command: Parameters<RunnerClient['start']>[0]) {
      return { cwd: command.cwd };
    },
    async resume(command: Parameters<RunnerClient['resume']>[0]) {
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async answer() {
      return { delivered: false };
    },
    async stop() {
      /* 使わない */
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
      /* 使わない */
    },
    async fetchArchive() {
      return undefined;
    },
    async deleteArchive() {
      /* 使わない */
    },
  } as unknown as RunnerClient;
  return {
    runner,
    raw(event: object) {
      emit?.(runnerEventSchema.parse(event));
    },
  };
}

let pool: ManagerPool | undefined;
afterEach(async () => {
  await pool?.stop();
  pool = undefined;
});

async function setup() {
  const stores: Stores = createMemoryStores();
  await stores.jobs.putJob(jobOf());
  const a = fakeRunner('runner-a', 'inst-a', []);
  const b = fakeRunner('runner-b', 'inst-b', [
    {
      liveBackgroundTasks: 0,
      managerId: MANAGER_ID,
      status: 'running',
      cwd: '/work/project',
      request: '退避して',
      waiting: [],
      sessionId: 'sess-moved',
    },
  ]);
  pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([a.runner, b.runner]),
  });
  await pool.restore();
  return { stores, a, b };
}

async function jobNow(stores: Stores): Promise<Job> {
  const found = (await stores.jobs.listJobs()).find((entry) => entry.id === MANAGER_ID);
  if (found === undefined) throw new Error('job が無い');
  return found;
}

function rescueRef(ref: string, commit: string, at: string) {
  return {
    type: 'rescue_ref',
    managerId: MANAGER_ID,
    worktrees: [
      { relativePath: '.', branch: 'feat/x', at, pushed: { ref, commit, at } },
    ],
  };
}

describe('移った後の古い器からの遅れた rescue_ref は、新しい器の項目を置き換えない', () => {
  it('器 B の項目（ref・commit・instanceId・at）が、器 A の遅れた同じ道筋の rescue_ref の後も残り、goneAt も付かない', async () => {
    const { stores, a, b } = await setup();
    b.raw(rescueRef(REF_B, 'b'.repeat(40), AT_B));
    await vi.waitFor(async () =>
      expect((await jobNow(stores)).lastRescue?.worktrees[0]?.pushed?.ref).toBe(REF_B),
    );

    a.raw(rescueRef(REF_A, 'a'.repeat(40), AT_A));
    // 同じ器の出来事は順に処理される前提で、後続の archive が届いたことを「A の rescue_ref も処理済み」の目印にする。
    a.raw({ type: 'archive', managerId: MANAGER_ID, body: '目印' });
    await vi.waitFor(async () => expect((await jobNow(stores)).archiveIds).toHaveLength(1));

    const tree = (await jobNow(stores)).lastRescue?.worktrees.find((w) => w.relativePath === '.');
    expect(tree?.pushed?.ref).toBe(REF_B);
    expect(tree?.pushed?.commit).toBe('b'.repeat(40));
    expect(tree?.instanceId).toBe('inst-b');
    expect(tree?.at).toBe(AT_B);
    expect(tree?.goneAt).toBeUndefined();
  });
});
