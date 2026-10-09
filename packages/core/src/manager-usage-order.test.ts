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
import type { UsageTotals } from './usage.js';

const RUNNING_JOB: Job = {
  id: 'mgr-tok',
  managerId: 'mgr-tok',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function totals(over: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    ...over,
  };
}

function usageRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      // 同期的に名乗らせない（本物は `void this.#pump(...)` で即 return する）。
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
    usage(models: Record<string, UsageTotals>, extra: { answered?: boolean } = {}): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit({
        type: 'usage',
        managerId: 'mgr-tok',
        sessionId: 'sess-1',
        models,
        ...extra,
      } as unknown as RunnerEvent);
    },
  };
}

function deferred() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function setup(options: {
  stores: Stores;
  onUsageObservation?: (observation: unknown) => Promise<void>;
}) {
  await options.stores.jobs.putJob(RUNNING_JOB);
  const fake = usageRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: options.stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores: options.stores, runners: registry }),
    ...(options.onUsageObservation === undefined
      ? {}
      : { onUsageObservation: options.onUsageObservation }),
  });
  await pool.restore();
  return { pool, fake };
}

async function costOf(stores: Stores): Promise<number> {
  const { rows } = await stores.usage.aggregate({});
  return rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('累積の usage は届いた順に積む（#3015）', () => {
  it('ターン結果の usage の観測が長引いても、後から届いた flush の usage に追い越されて過大に数えない', async () => {
    const stores = createMemoryStores();
    const gate = deferred();
    const s = await setup({ stores, onUsageObservation: () => gate.promise });

    s.fake.usage({ opus: totals({ costUsd: 5 }) }, { answered: true });
    s.fake.usage({ opus: totals({ costUsd: 9 }) });
    await settle();
    gate.open();

    await expect.poll(() => costOf(stores), { timeout: 2000 }).toBe(9);
    await settle();
    expect(await costOf(stores)).toBe(9);

    await s.pool.stop();
  });

  it('本物の数え直し（届いた順に累積が 0 から始まり直す）は今までどおり全量を数える', async () => {
    const stores = createMemoryStores();
    const s = await setup({ stores });

    s.fake.usage({ opus: totals({ costUsd: 9 }) });
    await expect.poll(() => costOf(stores), { timeout: 2000 }).toBe(9);
    s.fake.usage({ opus: totals({ costUsd: 3 }) });
    await expect.poll(() => costOf(stores), { timeout: 2000 }).toBe(12);

    await s.pool.stop();
  });

  it('観測が失敗しても後続の usage は積まれる（1件の失敗が鎖を止めない）', async () => {
    const stores = createMemoryStores();
    let first = true;
    const s = await setup({
      stores,
      onUsageObservation: async () => {
        if (first) {
          first = false;
          throw new Error('観測が落ちた');
        }
      },
    });

    s.fake.usage({ opus: totals({ costUsd: 2 }) }, { answered: true });
    s.fake.usage({ opus: totals({ costUsd: 6 }) });
    await expect.poll(() => costOf(stores), { timeout: 2000 }).toBe(6);

    await s.pool.stop();
  });

  it('record が1件失敗しても、後続の usage は積まれる（失敗は従来どおり日誌に跡を残す）', async () => {
    const stores = createMemoryStores();
    const real = stores.usage.record.bind(stores.usage);
    let calls = 0;
    stores.usage.record = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('台帳が落ちた');
      return real(input);
    };
    const s = await setup({ stores });

    s.fake.usage({ opus: totals({ costUsd: 2 }) });
    s.fake.usage({ opus: totals({ costUsd: 6 }) });
    await expect.poll(() => costOf(stores), { timeout: 2000 }).toBe(6);

    await s.pool.stop();
  });

  it('同じ累積が隣り合って二重に届いても（runner の SSE の差し戻し・再送の形）、二重に数えない（#3022 仮説3）', async () => {
    // 隣り合う二重だけを扱う: 非隣接の逆順（5,6,5）は runner が差し戻しで古い順を保つので届かない。
    const stores = createMemoryStores();
    const s = await setup({ stores });

    s.fake.usage({ opus: totals({ costUsd: 5 }) });
    s.fake.usage({ opus: totals({ costUsd: 5 }) });
    s.fake.usage({ opus: totals({ costUsd: 9 }) });
    s.fake.usage({ opus: totals({ costUsd: 9 }) });
    await expect.poll(() => costOf(stores), { timeout: 2000 }).toBe(9);
    await settle();
    expect(await costOf(stores)).toBe(9);

    await s.pool.stop();
  });
});
