import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { describeRescue } from './tools.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, RescueWorktree } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **走行中の退避 ref（`rescue_ref`。Issue #1266）が台帳（`Job.lastRescue`）へ残り、
 * `manager_list` の材料（`ManagerSummary.lastRescue`）へ出ること。** 足場は
 * `manager-shutdown-unpushed-work.test.ts` の複製（duplicated on purpose）。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  /** `pool.unpushedWork()` が呼ばれたときに返す値を差し替える。 */
  setUnpushedWorkResult(result: UnpushedWorkResult): void;
  rescueRef(managerId: string, worktrees: RescueWorktree[]): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  let unpushedWorkResult: UnpushedWorkResult | undefined;

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async send() {
      /* この検証では使わない */
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
    async unpushedWork() {
      return unpushedWorkResult;
    },
  };

  function send(raw: RunnerEvent): void {
    // **daemon の境界（`runnerEventSchema.safeParse`）を実際に通す。** スキーマに
    // 無い欄はここで黙って落ちるので、emit した中身だけを見ていると境界で
    // 消えたことに気づけない（`manager-closed-unpushed-work.test.ts` と同じ
    // 作法）。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  }

  return {
    runner,
    alive,
    setUnpushedWorkResult(result) {
      unpushedWorkResult = result;
    },
    rescueRef(managerId, worktrees) {
      send({ type: 'rescue_ref', managerId, worktrees });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId = 'mgr-quota',
  now?: () => number,
): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    ...(now === undefined ? {} : { now }),
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function listedOf(pool: ManagerPool, managerId: string) {
  const all = await pool.list();
  const found = all.find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

const AT1 = '2026-10-05T01:00:00.000Z';
const AT2 = '2026-10-05T01:05:00.000Z';

describe('台帳の lastRescue（Issue #1266）', () => {
  it('1. rescue_ref が台帳に残り、一覧の材料へ出る。status には触れない', async () => {
    const { pool, fake } = await runningManualSetup('mgr-rescue');
    fake.rescueRef('mgr-rescue', [
      {
        relativePath: '.',
        branch: 'feat/x',
        at: AT1,
        pushed: {
          ref: 'refs/alteroid-rescue/mgr-rescue/root-1234abcd',
          commit: 'a'.repeat(40),
          at: AT1,
        },
        untracked: { count: 2, paths: ['a.txt', 'b.txt'], omitted: 0 },
      },
    ]);
    await vi.waitFor(async () => {
      expect((await listedOf(pool, 'mgr-rescue')).lastRescue?.worktrees).toHaveLength(1);
    });

    const listed = await listedOf(pool, 'mgr-rescue');
    expect(listed.status).toBe('running');
    expect(listed.lastRescue?.worktrees).toHaveLength(1);
    expect(listed.lastRescue?.worktrees[0]?.pushed?.ref).toBe(
      'refs/alteroid-rescue/mgr-rescue/root-1234abcd',
    );
    expect(listed.lastRescue?.worktrees[0]?.untracked?.paths).toEqual(['a.txt', 'b.txt']);
    await pool.stop();
  });

  it('2. 後の回が送らなかったとき、pushed（最後に成功した退避）を残し、他の作業ツリーも残す', async () => {
    const { pool, fake } = await runningManualSetup('mgr-keep');
    const pushed = {
      ref: 'refs/alteroid-rescue/mgr-keep/root-1234abcd',
      commit: 'b'.repeat(40),
      at: AT1,
    };
    fake.rescueRef('mgr-keep', [
      { relativePath: '.', branch: 'main', at: AT1, pushed },
      { relativePath: 'wt', branch: 'topic', at: AT1, notPushed: { reason: 'no-credential' } },
    ]);
    fake.rescueRef('mgr-keep', [
      {
        relativePath: '.',
        branch: 'main',
        at: AT2,
        notPushed: { reason: 'secret-like', files: ['x.env'] },
      },
    ]);
    await vi.waitFor(async () => {
      const worktrees = (await listedOf(pool, 'mgr-keep')).lastRescue?.worktrees ?? [];
      expect(worktrees.find((w) => w.relativePath === '.')?.at).toBe(AT2);
    });

    const listed = await listedOf(pool, 'mgr-keep');
    const byPath = new Map(listed.lastRescue?.worktrees.map((w) => [w.relativePath, w]));
    expect(byPath.get('.')?.pushed).toEqual(pushed);
    expect(byPath.get('.')?.notPushed).toEqual({ reason: 'secret-like', files: ['x.env'] });
    expect(byPath.get('wt')?.notPushed?.reason).toBe('no-credential');
    await pool.stop();
  });

  it('3b. 同じ理由・同じファイルの繰り返し（運び直し）では日誌を積まない', async () => {
    const { pool, fake, stores } = await runningManualSetup('mgr-journal-dup');
    const tree = {
      relativePath: '.',
      branch: 'main',
      at: AT1,
      notPushed: { reason: 'secret-like' as const, files: ['config/prod.env'] },
    };
    fake.rescueRef('mgr-journal-dup', [tree]);
    fake.rescueRef('mgr-journal-dup', [{ ...tree, at: AT2 }]);
    // 2回目（運び直し）が台帳へ届いたのを見てから日誌を数える（実時間で待たない。#2146）。
    await vi.waitFor(async () => {
      const worktrees = (await listedOf(pool, 'mgr-journal-dup')).lastRescue?.worktrees ?? [];
      expect(worktrees[0]?.at).toBe(AT2);
    });
    const entries = await stores.journal.list({ types: ['decision'] });
    expect(entries.filter((e) => JSON.stringify(e).includes('鍵らしい文字列'))).toHaveLength(1);
    await pool.stop();
  });

  it('3. 鍵らしい文字列で止めた回は日誌へ残る（ファイル名だけ）', async () => {
    const { pool, fake, stores } = await runningManualSetup('mgr-journal');
    fake.rescueRef('mgr-journal', [
      {
        relativePath: '.',
        branch: 'main',
        at: AT1,
        notPushed: { reason: 'secret-like', files: ['config/prod.env'] },
      },
    ]);
    await vi.waitFor(async () => {
      const found = await stores.journal.list({ types: ['decision'] });
      expect(JSON.stringify(found)).toContain('鍵らしい文字列');
    });
    const entries = await stores.journal.list({ types: ['decision'] });
    expect(JSON.stringify(entries)).toContain('鍵らしい文字列');
    expect(JSON.stringify(entries)).toContain('config/prod.env');
    await pool.stop();
  });
});

describe('manager_list の退避 ref の行（Issue #1266）', () => {
  it('退避 ref の名前と sha、退避されなかったもの（名前だけ）を出し、無ければ1文字も足さない', () => {
    expect(describeRescue({ lastRescue: undefined } as never)).toBeNull();
    const text = describeRescue({
      lastRescue: {
        at: AT1,
        worktrees: [
          {
            relativePath: '.',
            branch: 'main',
            at: AT1,
            pushed: {
              ref: 'refs/alteroid-rescue/m/root-1234abcd',
              commit: 'c'.repeat(40),
              at: AT1,
            },
            notPushed: { reason: 'push-failed', failureKind: 'auth' },
            untracked: { count: 8, paths: ['1', '2', '3', '4', '5', '6'], omitted: 2 },
            submoduleCount: 1,
          },
        ],
      },
    } as never);
    expect(text).toContain('refs/alteroid-rescue/m/root-1234abcd（cccccccc,');
    expect(text).toContain('push に失敗した（auth）');
    expect(text).toContain('未追跡 8 件（1, 2, 3, 4, 5 ほか 3 件）');
    expect(text).toContain('submodule 1 本');
  });
});
