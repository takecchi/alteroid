import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { RunnerHttpError } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerEvent,
  RunnerLiveness,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
  RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('移送の最中に届く元の runner の report / ask / session（#3125。#3124 の範囲外の窓）', () => {
  function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
    return {
      label,
      state,
      ...(runnerId === undefined ? {} : { runnerId }),
      since: '2026-08-01T00:00:00.000Z',
      revision: { status: 'unheard' },
    };
  }

  function createFakeRegistry(): {
    registry: RunnerRegistry;
    entries: RunnerEntry[];
    addClient: (client: RunnerClient) => void;
  } {
    const clients = new Map<string, RunnerClient>();
    const entries: RunnerEntry[] = [];
    const registry: RunnerRegistry = {
      async list() {
        return [...clients.values()];
      },
      async get(runnerId) {
        return clients.get(runnerId) ?? null;
      },
      async select() {
        throw new Error('この試験群では使わない（配置は検証対象ではない）');
      },
      async register() {
        /* この試験群では使わない（`addClient` で直接足す）。 */
      },
      async unregister() {
        /* この試験群では使わない。 */
      },
      vacate() {
        /* この試験群では使わない。 */
      },
      entries() {
        return entries.map((entry) => ({ ...entry }));
      },
      noteManagerFailed() {
        /* この試験群では使わない。 */
      },
      subscribe() {
        return () => {};
      },
      async stop() {},
    };
    return {
      registry,
      entries,
      addClient: (client) => clients.set(client.runnerId, client),
    };
  }

  function fakeRunner(
    runnerId: string,
    workspacePath = '/work/project',
  ): {
    client: RunnerClient;
    resumes: RunnerResumeCommand[];
    readonly emit: ((event: RunnerEvent) => void) | undefined;
  } {
    const resumes: RunnerResumeCommand[] = [];
    const sessions = new Map<string, RunnerManagerState>();
    const holder: { emit?: (event: RunnerEvent) => void } = {};
    const client: RunnerClient = {
      runnerId,
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath,
      async connect(onEvent) {
        holder.emit = onEvent;
      },
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(command): Promise<{ cwd?: string }> {
        resumes.push(command);
        sessions.set(command.managerId, {
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
      async stop(managerId) {
        sessions.delete(managerId);
      },
      async list() {
        return [...sessions.values()];
      },
      async transcript() {
        return null;
      },
      async credentials(): Promise<RunnerCredentialFingerprint[]> {
        return [];
      },
      async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
        return [];
      },
      async profile(): Promise<RunnerProfileFingerprint | undefined> {
        return undefined;
      },
      async setProfile(): Promise<RunnerProfileResult> {
        return { ok: true };
      },
      async close() {
        /* この試験群では使わない。 */
      },
    };
    return {
      client,
      resumes,
      get emit() {
        return holder.emit;
      },
    };
  }

  function jobWith(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
    return {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '走行中の委譲',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-relocate',
      lastReport: '途中まで進めた',
      ...(runnerId === undefined ? {} : { runnerId }),
      ...overrides,
    };
  }

  it('runner-b への resume が飛んでいる最中に runner-a の遅れた report が届いても、移送が受理されたなら台帳の lastReport とクローンの受信箱へは流さない（移った後に届いた場合＝#3059 と同じ扱い）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-inflight', 'runner-a', {
        lease: {
          runnerId: 'runner-a',
          fence: 4,
          grantedAt: '2026-01-01T00:00:00.000Z',
          seenAt: '2026-01-01T00:00:00.000Z',
          ttlMs: 60_000,
        },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerB.client.resume.bind(runnerB.client);
    runnerB.client.resume = async (command) => {
      entered();
      await gate;
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const inbox: unknown[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
    });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-b');
    await enteredResume;
    const before = inbox.length;
    runnerA.emit?.({
      type: 'report',
      managerId: 'mgr-inflight',
      status: 'failed',
      text: 'runner-a からの古い報告（移送の最中に遅延して届いた）',
      reportId: 'stale-report-window',
    } as RunnerEvent);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-inflight');
    expect({
      status: after?.status,
      runnerId: after?.runnerId,
      lastReport: after?.lastReport,
      // 移送受理の通知は正当にクローンへ届くので、古い報告の本文を運ぶものだけ数える。
      reportsToClone: inbox
        .slice(before)
        .filter(
          (event) =>
            (event as { type?: string }).type === 'manager_message' &&
            (event as { kind?: string }).kind === 'report' &&
            ((event as { text?: string }).text ?? '').includes('runner-a からの古い報告'),
        ).length,
    }).toEqual({
      status: 'running',
      runnerId: 'runner-b',
      lastReport: '途中まで進めた',
      reportsToClone: 0,
    });
    await pool.stop();
  });

  async function runWindow(
    resume: 'accepted' | 'refused',
    events: RunnerEvent[],
  ): Promise<{
    job: Job | undefined;
    toClone: { type?: string; kind?: string; text?: string }[];
  }> {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-inflight', 'runner-a', {
        lease: {
          runnerId: 'runner-a',
          fence: 4,
          grantedAt: '2026-01-01T00:00:00.000Z',
          seenAt: '2026-01-01T00:00:00.000Z',
          ttlMs: 60_000,
        },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerB.client.resume.bind(runnerB.client);
    runnerB.client.resume = async (command) => {
      entered();
      await gate;
      if (resume === 'refused') throw new RunnerHttpError('unavailable', 503);
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const inbox: unknown[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
    });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-b');
    await enteredResume;
    const before = inbox.length;
    for (const event of events) runnerA.emit?.(event);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-inflight');
    const toClone = inbox.slice(before) as { type?: string; kind?: string; text?: string }[];
    await pool.stop();
    return { job, toClone };
  }

  const askEvent = {
    type: 'ask',
    managerId: 'mgr-inflight',
    requestId: 'stale-ask-window',
    kind: 'permission',
    summary: 'Bash の実行許可（runner-a からの古い確認）',
  } as RunnerEvent;

  it('移送が受理されたなら、窓の間に届いた runner-a の ask は待ちへ積まず、クローンへも配らない', async () => {
    const { job, toClone } = await runWindow('accepted', [askEvent]);
    expect({
      status: job?.status,
      runnerId: job?.runnerId,
      toClone: toClone.filter((event) => (event.text ?? '').includes('runner-a からの古い確認'))
        .length,
    }).toEqual({ status: 'running', runnerId: 'runner-b', toClone: 0 });
  });

  it('移送が受理されたなら、窓の間に届いた runner-a の session は台帳の sessionId を書き換えない', async () => {
    const { job } = await runWindow('accepted', [
      { type: 'session', managerId: 'mgr-inflight', sessionId: 'sess-stale-a' } as RunnerEvent,
    ]);
    expect({ runnerId: job?.runnerId, sessionId: job?.sessionId }).toEqual({
      runnerId: 'runner-b',
      sessionId: 'sess-before-relocate',
    });
  });

  it('移送が失敗した（runner-b の resume が 503）なら、窓の間に届いた runner-a の report は届いた順に台帳と受信箱へ効き、同じ reportId は二度効かない', async () => {
    const report = (reportId: string, text: string): RunnerEvent =>
      ({
        type: 'report',
        managerId: 'mgr-inflight',
        status: 'running',
        text,
        reportId,
      }) as RunnerEvent;
    const { job, toClone } = await runWindow('refused', [
      report('r1', '一つ目'),
      report('r1', '一つ目'),
      report('r2', '二つ目'),
    ]);
    expect({
      runnerId: job?.runnerId,
      lastReport: job?.lastReport,
      reportsToClone: toClone.filter(
        (event) =>
          event.type === 'manager_message' &&
          event.kind === 'report' &&
          ['一つ目', '二つ目'].includes(event.text ?? ''),
      ).length,
    }).toEqual({ runnerId: 'runner-a', lastReport: '二つ目', reportsToClone: 2 });
  });

  it('移送が失敗したなら、窓の間に届いた runner-a の ask は従来どおり待ちへ積まれ、同じ requestId は二度積まれない', async () => {
    const { job, toClone } = await runWindow('refused', [askEvent, askEvent]);
    expect({
      status: job?.status,
      toClone: toClone.filter((event) => (event.text ?? '').includes('runner-a からの古い確認'))
        .length,
    }).toEqual({ status: 'waiting_human', toClone: 1 });
  });
});
