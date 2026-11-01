import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
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
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('移送の resume が応答なしで失敗したが移送先では起きていた回の取り直し', () => {
  function entryOf(label: string, state: RunnerLiveness, runnerId: string): RunnerEntry {
    return {
      label,
      state,
      runnerId,
      since: '2026-08-01T00:00:00.000Z',
      revision: { status: 'unheard' },
    };
  }

  function createFakeRegistry(entries: RunnerEntry[], clients: RunnerClient[]): RunnerRegistry {
    const byId = new Map(clients.map((client) => [client.runnerId, client]));
    return {
      async list() {
        return [...byId.values()];
      },
      async get(runnerId) {
        return byId.get(runnerId) ?? null;
      },
      async select() {
        throw new Error('この試験では使わない');
      },
      async register() {},
      async unregister() {},
      vacate() {},
      entries() {
        return entries.map((entry) => ({ ...entry }));
      },
      noteManagerFailed() {},
      subscribe() {
        return () => {};
      },
      async stop() {},
    };
  }

  it('移送先が resume を受理して応答だけ返せなかった後の取り直しで、台帳の宛先を移送先へ付け替え、移送先からの報告を受け取る', async () => {
    const stores = createMemoryStores();
    const job: Job = {
      id: 'mgr-alive-on-target',
      managerId: 'mgr-alive-on-target',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '走行中の委譲',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-1',
      lastReport: '途中まで進めた',
      runnerId: 'runner-a',
      lease: {
        runnerId: 'runner-a',
        fence: 4,
        grantedAt: '2026-01-01T00:00:00.000Z',
        seenAt: '2026-01-01T00:00:00.000Z',
        ttlMs: 60_000,
      },
    };
    await stores.jobs.putJob(job);

    const sessionsOnB = new Map<string, RunnerManagerState>();
    let listBroken = false;
    let emitFromB: ((event: RunnerEvent) => void) | undefined;
    const makeClient = (runnerId: string): RunnerClient => ({
      runnerId,
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent) {
        if (runnerId === 'runner-b') emitFromB = onEvent;
      },
      async start(command): Promise<{ cwd: string }> {
        return { cwd: command.cwd };
      },
      async resume(command): Promise<{ cwd: string }> {
        if (runnerId !== 'runner-b') return { cwd: command.cwd };
        // 受理してセッションを起こしたが、応答は返せず、直後の一覧の確認も落ちる。
        sessionsOnB.set(command.managerId, {
          liveBackgroundTasks: 0,
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        listBroken = true;
        throw new Error('fetch failed');
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop(managerId) {
        sessionsOnB.delete(managerId);
      },
      async list() {
        if (runnerId !== 'runner-b') return [];
        if (listBroken) {
          listBroken = false;
          throw new Error('fetch failed');
        }
        return [...sessionsOnB.values()];
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
      async close() {},
    });
    const runnerA = makeClient('runner-a');
    const runnerB = makeClient('runner-b');
    const registry = createFakeRegistry(
      [entryOf('runner-a', 'lost', 'runner-a'), entryOf('runner-b', 'connected', 'runner-b')],
      [runnerA, runnerB],
    );
    const inbox: { type?: string; kind?: string; text?: string }[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event as { type?: string; kind?: string; text?: string }),
      runners: registry,
    });
    await pool.abort('mgr-does-not-exist');

    // 1回目: resume の応答が返らず、一覧の確認も落ちるので、効いたかを確かめられずに挑み直しへ回る。
    await pool.reattachRunner('runner-b');
    // 2回目（梯子か hello の名乗り）: 移送先の一覧にこの委譲が居る。
    await pool.reattachRunner('runner-b');

    emitFromB?.({
      type: 'report',
      managerId: 'mgr-alive-on-target',
      status: 'running',
      text: 'runner-b で走っている担当の報告',
      reportId: 'report-from-b',
    } as RunnerEvent);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-alive-on-target');
    const dropped = (await stores.journal.list()).filter((entry) =>
      JSON.stringify(entry).includes('runner-id 不一致のため無視'),
    ).length;
    expect({
      droppedAsMovedAway: dropped,
      runnerId: after?.runnerId,
      lastReport: after?.lastReport,
      reportsToClone: inbox.filter(
        (event) =>
          event.type === 'manager_message' &&
          event.kind === 'report' &&
          (event.text ?? '').includes('runner-b で走っている担当の報告'),
      ).length,
    }).toEqual({
      droppedAsMovedAway: 0,
      runnerId: 'runner-b',
      lastReport: 'runner-b で走っている担当の報告',
      reportsToClone: 1,
    });
    await pool.stop();
  });
});
