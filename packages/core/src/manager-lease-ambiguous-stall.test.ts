import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobLease, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

class LeasedRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  instanceId: string | undefined = 'boot-2';
  resumeFailure: unknown;
  sendFailure: unknown;
  setProfileCalled = 0;
  listCalled = 0;
  // 名簿の heartbeat（10秒間隔）もここを通るので、差分で見ること: 絶対値はテストが走った長さに依存する。
  identityCalled = 0;

  constructor(runnerId = 'runner-primary') {
    this.runnerId = runnerId;
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    this.identityCalled += 1;
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
    };
  }

  hold(managerId: string): void {
    this.sessions.set(managerId, {
      managerId,
      status: 'running',
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  emit: ((event: RunnerEvent) => void) | undefined;

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.emit = onEvent;
  }
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
    if (this.resumeFailure !== undefined) throw this.resumeFailure;
    this.resumes.push(command);
    this.hold(command.managerId);
    return {};
  }
  async send(): Promise<boolean> {
    if (this.sendFailure !== undefined) throw this.sendFailure;
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    this.listCalled += 1;
    return [...this.sessions.values()];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    this.setProfileCalled += 1;
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface Harness {
  pool: ManagerPool;
  registry: RunnerRegistry;
  stores: Stores;
  runner: LeasedRunner;
  advance: (ms: number) => void;
  breakWrites: (reason: string) => void;
  // 関門（`#claimForResume`）を通った後に失敗する枝を作れるのはここだけ: 「貸し出しだけ新しい器へ進んで、告げる1行は届かない」状態はここからしか作れない。ジョブが `projectKey` を持っていないと効かない（`#loadSession` が store を触らず `absent` を返す）。
  breakSessionLog: (reason: string) => void;
  healSessionLog: () => void;
  inbox: InboxEvent[];
  journal: () => Promise<JournalEntry[]>;
  close: () => Promise<void>;
}

async function harnessOf(options: { silent?: boolean } = {}): Promise<Harness> {
  const runner = new LeasedRunner();
  // 名乗らせないなら登録の前に決める: 名簿は開けた瞬間に名乗りを聞くので、後から消しても最後に名乗った値が残る。
  if (options.silent === true) runner.instanceId = undefined;
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const base = createMemoryStores();
  // `failingJobWrite`（`testing.ts`）は使わない: 最初から壊れているので、走っていた委譲を台帳に置いてから壊す状態を作れない。
  let writeFailure: string | undefined;
  let sessionLogFailure: string | undefined;
  const stores: Stores = {
    ...base,
    jobs: {
      ...base.jobs,
      putJob: async (job) => {
        if (writeFailure !== undefined) throw new Error(writeFailure);
        await base.jobs.putJob(job);
      },
    },
    sessionStore: {
      append: async () => undefined,
      load: async () => {
        if (sessionLogFailure !== undefined) throw new Error(sessionLogFailure);
        return null;
      },
    },
  };
  let clock = Date.now();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock,
  });
  return {
    pool,
    registry,
    stores,
    runner,
    advance: (ms) => {
      clock += ms;
    },
    breakWrites: (reason) => {
      writeFailure = reason;
    },
    breakSessionLog: (reason) => {
      sessionLogFailure = reason;
    },
    healSessionLog: () => {
      sessionLogFailure = undefined;
    },
    inbox,
    journal: async () => base.journal.list({ limit: 100 }),
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

function runningJob(lease: JobLease | undefined): Job {
  const at = new Date(Date.now() - 1_000).toISOString();
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: '走っていた仕事',
    request: '走っていた仕事の依頼',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...(lease === undefined ? {} : { lease }),
  };
}

function leaseHeldBy(
  instanceId: string | undefined,
  fence = 4,
  overrides: Partial<JobLease> = {},
): JobLease {
  return {
    runnerId: 'runner-primary',
    ...(instanceId === undefined ? {} : { instanceId }),
    fence,
    grantedAt: new Date(Date.now() - 2_000).toISOString(),
    seenAt: new Date(Date.now() - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('併存が解けた後の取り直し（hello 無し / 有り）', () => {
  async function setup() {
    vi.useFakeTimers();
    const h = await harnessOf();
    const duplicate = new LeasedRunner('runner-primary');
    await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1', 4, { ttlMs: 1_000 })));
    await h.pool.restore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.runner.resumes).toEqual([]);
    // 猶予も過ぎさせる: 併存が解けたこと以外に断る理由を残さない。
    await h.registry.unregister('http://runner-dup:4518');
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    return { h, duplicate };
  }

  it('対照: 解けた後に hello を送れば取り直される', async () => {
    const { h } = await setup();
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.runner.resumes.length).toBe(1);
    await h.close();
  });

  it('併存が解けても hello が無ければ、梯子で取り直される（#3148）', async () => {
    const { h } = await setup();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.runner.resumes.length).toBe(1);
    await h.close();
  });

  it('併存が続く間に梯子が何回回っても、日誌と知らせは積まれず、取り直しもしない', async () => {
    vi.useFakeTimers();
    const h = await harnessOf();
    const duplicate = new LeasedRunner('runner-primary');
    await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1', 4, { ttlMs: 1_000 })));
    await h.pool.restore();
    await vi.advanceTimersByTimeAsync(5_000);
    const journalBefore = (await h.journal()).length;
    const inboxBefore = h.inbox.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect({
      journal: (await h.journal()).length,
      inbox: h.inbox.length,
      resumes: h.runner.resumes.length,
    }).toEqual({ journal: journalBefore, inbox: inboxBefore, resumes: 0 });
    await h.close();
  });
});
