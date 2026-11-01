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

// 担当が別の器（runner-b）へ移った後に、古い器（runner-a）から届く archive / mirror / rescue_ref。
// `MOVED_AWAY_IGNORED_EVENT_TYPES` に無い種類なので、捨てずに取り込む（取りに行く先は出来事を出した器）。
// 切り出しで「移った後は捨てる」守りを足したり、取りに行く先を `job.runnerId` へ変えたりすると、預けた本文や生ログが失われる。

const MANAGER_ID = 'mgr-moved';
const ARCHIVE_ID = '0b5c6e1a-2f3d-4a7b-9c8d-1e2f3a4b5c6d';

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
    projectKey: 'proj-key',
  };
}

function fakeRunner(runnerId: string, alive: RunnerManagerState[]) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const fetches: string[] = [];
  const deletes: string[] = [];
  const stored = new Map<string, string>();
  const runner = {
    runnerId,
    runnerIdKnown: true,
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
    async fetchArchive(managerId: string, archiveId: string) {
      fetches.push(`${managerId}/${archiveId}`);
      return stored.get(archiveId);
    },
    async deleteArchive(managerId: string, archiveId: string) {
      deletes.push(`${managerId}/${archiveId}`);
      stored.delete(archiveId);
    },
  } as unknown as RunnerClient;
  return {
    runner,
    fetches,
    deletes,
    stored,
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
  const appended: string[] = [];
  const base = createMemoryStores();
  const stores: Stores = {
    ...base,
    sessionStore: {
      append: async (_key, entries) => {
        for (const entry of entries) appended.push(String((entry as { uuid?: string }).uuid));
      },
      load: async () => null,
    },
  };
  await stores.jobs.putJob(jobOf());
  // 担当は b にだけ居る（a からは移った後）
  const a = fakeRunner('runner-a', []);
  const b = fakeRunner('runner-b', [
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
  return { stores, a, b, appended };
}

async function jobNow(stores: Stores): Promise<Job> {
  const found = (await stores.jobs.listJobs()).find((entry) => entry.id === MANAGER_ID);
  if (found === undefined) throw new Error('job が無い');
  return found;
}

describe('移った後の古い器からの archive / mirror / rescue_ref は、捨てずに取り込む', () => {
  it('archive（参照）: 取りに行く先は出来事を出した古い器で、置き場へ入れ、その器に消させる。今の器へは聞かない', async () => {
    const { stores, a, b } = await setup();
    a.stored.set(ARCHIVE_ID, '古い器に預けた生ログ');
    a.raw({
      type: 'archive',
      managerId: MANAGER_ID,
      ref: { id: ARCHIVE_ID, chars: 10 },
    });
    await vi.waitFor(async () => expect((await jobNow(stores)).archiveIds).toHaveLength(1));
    const [archiveId] = (await jobNow(stores)).archiveIds ?? [];
    expect(await stores.archive.read(archiveId!)).toEqual({
      kind: 'body',
      body: '古い器に預けた生ログ',
    });
    expect(a.fetches).toEqual([`${MANAGER_ID}/${ARCHIVE_ID}`]);
    await vi.waitFor(() => expect(a.deletes).toEqual([`${MANAGER_ID}/${ARCHIVE_ID}`]));
    expect(b.fetches).toEqual([]);
    expect(b.deletes).toEqual([]);
  });

  it('archive（本文）: 置き場へ入れる', async () => {
    const { stores, a } = await setup();
    a.raw({ type: 'archive', managerId: MANAGER_ID, body: '古い形の本文' });
    await vi.waitFor(async () => expect((await jobNow(stores)).archiveIds).toHaveLength(1));
    const [archiveId] = (await jobNow(stores)).archiveIds ?? [];
    expect(await stores.archive.read(archiveId!)).toEqual({ kind: 'body', body: '古い形の本文' });
  });

  it('mirror: 生ログの写しを預ける', async () => {
    const { a, appended } = await setup();
    a.raw({
      type: 'mirror',
      managerId: MANAGER_ID,
      key: { projectKey: 'proj-key', sessionId: 'sess-moved' },
      entries: [{ type: 'user', uuid: 'from-old-runner' }],
    });
    await vi.waitFor(() => expect(appended).toEqual(['from-old-runner']));
  });

  it('rescue_ref: 台帳の lastRescue へ取り込み、status・runnerId には触れない', async () => {
    const { stores, a } = await setup();
    a.raw({
      type: 'rescue_ref',
      managerId: MANAGER_ID,
      worktrees: [
        {
          relativePath: '.',
          branch: 'feat/x',
          at: '2026-10-12T01:00:00.000Z',
          pushed: {
            ref: 'refs/alteroid-rescue/mgr-moved/root-1234abcd',
            commit: 'a'.repeat(40),
            at: '2026-10-12T01:00:00.000Z',
          },
        },
      ],
    });
    await vi.waitFor(async () =>
      expect((await jobNow(stores)).lastRescue?.worktrees).toHaveLength(1),
    );
    const after = await jobNow(stores);
    expect(after.lastRescue?.worktrees[0]?.pushed?.ref).toBe(
      'refs/alteroid-rescue/mgr-moved/root-1234abcd',
    );
    expect(after.status).toBe('running');
    expect(after.runnerId).toBe('runner-b');
  });
});
