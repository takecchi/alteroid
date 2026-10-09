import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
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
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const RUNNING_JOB: Job = {
  id: 'mgr-gen',
  managerId: 'mgr-gen',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

const RUNNING_JOB_2: Job = {
  id: 'mgr-gen-2',
  managerId: 'mgr-gen-2',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'running',
  summary: '調べもの2',
  request: '調べておいて2',
  cwd: '/work/project',
  sessionId: 'sess-2',
  runnerId: 'runner-primary',
};

const DONE_JOB: Job = {
  id: 'mgr-gen-done',
  managerId: 'mgr-gen-done',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'done',
  summary: '調べもの3',
  request: '調べておいて3',
  cwd: '/work/project',
  sessionId: 'sess-3',
  runnerId: 'runner-primary',
};

function tokenRunner() {
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
    async stop() {
      /* この検証では使わない */
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
    note(tokenRotation?: true): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit({
        type: 'note',
        managerId: 'mgr-gen',
        text: '認証トークンが差し替わったので、ターンの境界でセッションを畳んで開き直した。',
        ...(tokenRotation === undefined ? {} : { tokenRotation }),
      } as unknown as RunnerEvent);
    },
  };
}

async function setup(options: {
  stores: Stores;
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
}) {
  await options.stores.jobs.putJob(RUNNING_JOB);
  const fake = tokenRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: options.stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores: options.stores, runners: registry }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
  });
  await pool.restore();
  return { pool, fake };
}

async function summaryFor(pool: Awaited<ReturnType<typeof setup>>['pool'], managerId: string) {
  const list = await pool.list();
  const found = list.find((s) => s.managerId === managerId);
  if (found === undefined) throw new Error(`${managerId} が list() に見つからない`);
  return found;
}

describe('マネージャーが抱えている認証トークンの世代（Issue #914 提案1）', () => {
  it('`tokenIdentity` を配線していない器では、世代の欄が1文字も立たない', async () => {
    const stores = createMemoryStores();
    const { pool } = await setup({ stores });

    const summary = await summaryFor(pool, 'mgr-gen');

    expect(summary.tokenGeneration).toBeUndefined();
    expect(summary.activeTokenGeneration).toBeUndefined();
    expect(summary.tokenGenerationUnknownReason).toBe('pool-not-wired');

    await pool.stop();
  });

  it('プールは配線されているが、まだ一度も起きていない委譲は「一度も観測されていない」と名乗る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(DONE_JOB);
    const { pool } = await setup({
      stores,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 3 }),
    });

    const observed = await summaryFor(pool, 'mgr-gen');
    expect(observed.tokenGeneration).toBe(3);

    const summary = await summaryFor(pool, 'mgr-gen-done');
    expect(summary.tokenGeneration).toBeUndefined();
    expect(summary.tokenGenerationUnknownReason).toBe('not-yet-observed');

    await pool.stop();
  });

  it('セッションが起きた瞬間の世代が、現役と一致していれば両方が同じ値になる', async () => {
    const stores = createMemoryStores();
    const { pool } = await setup({
      stores,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 3 }),
    });

    const summary = await summaryFor(pool, 'mgr-gen');

    expect(summary.tokenGeneration).toBe(3);
    expect(summary.activeTokenGeneration).toBe(3);

    await pool.stop();
  });

  it('現役が回った後も、ターンの境界に達していないマネージャーは古い世代を抱えたまま食い違う', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };

    const summary = await summaryFor(pool, 'mgr-gen');

    expect(summary.tokenGeneration).toBe(3);
    expect(summary.activeTokenGeneration).toBe(5);

    await pool.stop();
  });

  it('runner がターンの境界で自動的に開き直すと（note.tokenRotation）、抱えている世代が現役に追いつく', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool, fake } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };
    expect((await summaryFor(pool, 'mgr-gen')).tokenGeneration).toBe(3);

    fake.note(true);

    const summary = await summaryFor(pool, 'mgr-gen');
    expect(summary.tokenGeneration).toBe(5);
    expect(summary.activeTokenGeneration).toBe(5);

    await pool.stop();
  });

  it('`tokenRotation` を伴わない普通の note では、抱えている世代を追いつかせない', async () => {
    // 文字列で判定しない: `text` の言い回しに反応すると他の note でも世代が動き、ターン境界以外の理由で食い違いが消えて検知が無意味になる。
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool, fake } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };
    fake.note();

    const summary = await summaryFor(pool, 'mgr-gen');
    expect(summary.tokenGeneration).toBe(3);
    expect(summary.activeTokenGeneration).toBe(5);

    await pool.stop();
  });

  it('runners()（runner_list の材料）にも同じ世代がそのまま伝わる', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };

    const overview = await pool.runners();
    const runner = overview.runners.find((r) => r.runnerId === 'runner-primary');
    if (runner === undefined) throw new Error('runner-primary が見つからない');
    const entry = runner.managers.find((m) => m.managerId === 'mgr-gen');
    if (entry === undefined) throw new Error('mgr-gen が runner-primary の内訳に無い');

    expect(entry.tokenGeneration).toBe(3);
    expect(entry.activeTokenGeneration).toBe(5);

    await pool.stop();
  });
});

describe('デーモン再起動を挟んだ二重 restore（Issue #978）', () => {
  it('living 枝で引き取ったセッションは、runner の env を更新していないのに、デーモン再起動後は世代の食い違いが消える（偽陰性）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(RUNNING_JOB);
    await stores.jobs.putJob(RUNNING_JOB_2);

    let current: { tokenId: string; generation: number } = { tokenId: 'tok-a', generation: 3 };

    const fake = tokenRunner();
    const registry1 = createRunnerRegistry([fake.runner]);
    const pool1 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry1,
      profile: createProfileService({ stores, runners: registry1 }),
      tokenIdentity: () => current,
    });
    await pool1.restore();

    const before1 = await summaryFor(pool1, 'mgr-gen');
    const before2 = await summaryFor(pool1, 'mgr-gen-2');
    expect(before1.tokenGeneration).toBe(3);
    expect(before1.activeTokenGeneration).toBe(3);
    expect(before2.tokenGeneration).toBe(3);
    expect(before2.activeTokenGeneration).toBe(3);

    current = { tokenId: 'tok-b', generation: 5 };

    const afterRotation1 = await summaryFor(pool1, 'mgr-gen');
    const afterRotation2 = await summaryFor(pool1, 'mgr-gen-2');
    expect(afterRotation1.tokenGeneration).toBe(3);
    expect(afterRotation1.activeTokenGeneration).toBe(5);
    expect(afterRotation2.tokenGeneration).toBe(3);
    expect(afterRotation2.activeTokenGeneration).toBe(5);

    await pool1.stop();

    const registry2 = createRunnerRegistry([fake.runner]);
    const pool2 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry2,
      profile: createProfileService({ stores, runners: registry2 }),
      tokenIdentity: () => current,
    });
    await pool2.restore();

    const after1 = await summaryFor(pool2, 'mgr-gen');
    const after2 = await summaryFor(pool2, 'mgr-gen-2');

    expect(after1.tokenGeneration).toBeUndefined();
    expect(after1.activeTokenGeneration).toBeUndefined();
    expect(after2.tokenGeneration).toBeUndefined();
    expect(after2.activeTokenGeneration).toBeUndefined();
    expect(after1.tokenGenerationUnknownReason).toBe('reattached-across-restart');
    expect(after2.tokenGenerationUnknownReason).toBe('reattached-across-restart');

    await pool2.stop();
  });

  it('再起動後に daemon がこの委譲へ実際に触れば、「再起動をまたいだ」の印は消える', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(RUNNING_JOB);
    await stores.jobs.putJob(RUNNING_JOB_2);

    let current: { tokenId: string; generation: number } = { tokenId: 'tok-a', generation: 3 };

    const fake = tokenRunner();
    const registry1 = createRunnerRegistry([fake.runner]);
    const pool1 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry1,
      profile: createProfileService({ stores, runners: registry1 }),
      tokenIdentity: () => current,
    });
    await pool1.restore();
    current = { tokenId: 'tok-b', generation: 5 };
    await pool1.stop();

    const registry2 = createRunnerRegistry([fake.runner]);
    const pool2 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry2,
      profile: createProfileService({ stores, runners: registry2 }),
      tokenIdentity: () => current,
    });
    await pool2.restore();

    expect((await summaryFor(pool2, 'mgr-gen')).tokenGenerationUnknownReason).toBe(
      'reattached-across-restart',
    );
    expect((await summaryFor(pool2, 'mgr-gen-2')).tokenGenerationUnknownReason).toBe(
      'reattached-across-restart',
    );

    fake.note(true);

    const touched = await summaryFor(pool2, 'mgr-gen');
    const untouched = await summaryFor(pool2, 'mgr-gen-2');

    expect(touched.tokenGeneration).toBe(5);
    expect(touched.tokenGenerationUnknownReason).toBeUndefined();
    expect(untouched.tokenGeneration).toBeUndefined();
    expect(untouched.tokenGenerationUnknownReason).toBe('reattached-across-restart');

    await pool2.stop();
  });
});
