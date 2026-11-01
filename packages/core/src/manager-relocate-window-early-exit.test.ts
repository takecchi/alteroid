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

describe('移送の窓は、resume が受理されなかった早い抜け方でも閉じる', () => {
  function entryOf(label: string, state: RunnerLiveness): RunnerEntry {
    return {
      label,
      state,
      runnerId: label,
      since: '2026-08-01T00:00:00.000Z',
      revision: { status: 'unheard' },
    };
  }

  function fakeRunner(runnerId: string): {
    client: RunnerClient;
    readonly emit: ((event: RunnerEvent) => void) | undefined;
  } {
    const holder: { emit?: (event: RunnerEvent) => void } = {};
    const sessions = new Map<string, RunnerManagerState>();
    const client: RunnerClient = {
      runnerId,
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent) {
        holder.emit = onEvent;
      },
      async start(command): Promise<{ cwd: string }> {
        return { cwd: command.cwd };
      },
      async resume(command): Promise<{ cwd: string }> {
        return { cwd: command.cwd };
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop() {},
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
      async close() {},
    };
    return {
      client,
      get emit() {
        return holder.emit;
      },
    };
  }

  it('session_id を持たない委譲の移送は no-session で確定して抜けるが、窓は閉じ、元の runner の出来事は預かりっぱなしにならない', async () => {
    const stores = createMemoryStores();
    const job: Job = {
      id: 'mgr-no-session',
      managerId: 'mgr-no-session',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '走行中の委譲',
      request: '続きをやって',
      cwd: '/work/project',
      runnerId: 'runner-a',
    };
    await stores.jobs.putJob(job);
    const clients = new Map<string, RunnerClient>();
    const entries = [entryOf('runner-a', 'lost'), entryOf('runner-b', 'connected')];
    const registry: RunnerRegistry = {
      async list() {
        return [...clients.values()];
      },
      async get(runnerId) {
        return clients.get(runnerId) ?? null;
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
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    clients.set('runner-a', runnerA.client);
    clients.set('runner-b', runnerB.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: registry });
    await pool.abort('mgr-does-not-exist');

    await pool.reattachRunner('runner-b');
    // 窓が開いたままなら、この report は預けられたまま台帳へ届かない。
    runnerA.emit?.({
      type: 'report',
      managerId: 'mgr-no-session',
      status: 'running',
      text: '窓が閉じた後の報告',
      reportId: 'after-window',
    } as RunnerEvent);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-no-session');
    expect({ status: after?.status, lastReport: after?.lastReport }).toEqual({
      status: 'lost',
      lastReport: '窓が閉じた後の報告',
    });
    await pool.stop();
  });
});
