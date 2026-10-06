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
  RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('reattach のループが写しの job.runnerId で移送かどうかを決める（await の間に宛先が変わる順序）', () => {
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

  /**
   * `manager-abort-moved.test.ts` の `fakeRunner` と同じ形だが、`connect()` が
   * 受け取った `onEvent` を `emit` として外へ持ち出す（テストから runner 発の
   * 出来事を流すため）。
   */
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
        /* この試験群では使わない。 */
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

  /** 先頭の1本（mgr-first）の resume だけ、手で解く gate で止める。 */
  function gateFirstResume(fake: ReturnType<typeof fakeRunner>): {
    entered: Promise<void>;
    release: () => void;
  } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const plain = fake.client.resume.bind(fake.client);
    fake.client.resume = async (command) => {
      if (command.managerId === 'mgr-first') {
        entered();
        await gate;
      }
      return plain(command);
    };
    return { entered: enteredPromise, release };
  }

  it('落ちた runner-a の委譲を runner-b が移送し終えた後に、遅れていた runner-c の取り直しが、健全に走る委譲を「セッションが無い」にしない（二重起動は貸し出しが止める）', async () => {
    const stores = createMemoryStores();
    // mgr-first は runner-c 自身の委譲（c の再起動で消えた）。mgr-moved は lost な runner-a の委譲。
    await stores.jobs.putJob(jobWith('mgr-first', 'runner-c'));
    await stores.jobs.putJob(jobWith('mgr-moved', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    const runnerB = fakeRunner('runner-b');
    const runnerC = fakeRunner('runner-c');
    const gateC = gateFirstResume(runnerC);
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.abort('mgr-does-not-exist');

    // runner-c の hello。mgr-first の resume が遅く、mgr-moved の番はまだ来ない（写しの宛先は runner-a）。
    const reattachC = pool.reattachRunner('runner-c');
    await gateC.entered;
    // その間に runner-b の hello。mgr-moved を runner-b へ移送し終える（台帳の宛先は runner-b になる）。
    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-moved']);
    expect((await stores.jobs.listJobs()).find((j) => j.id === 'mgr-moved')?.runnerId).toBe(
      'runner-b',
    );
    gateC.release();
    await reattachC;

    const summary = (await pool.list()).find((s) => s.managerId === 'mgr-moved');
    expect(runnerC.resumes.map((c) => c.managerId)).toEqual(['mgr-first']);
    // 起こされなくても（貸し出しが断る）、健全に走っている委譲へ「セッションが無い・resume に失敗」を付けない。
    expect(summary?.runnerId).toBe('runner-b');
    expect(summary?.sessionMissingSince).toBeUndefined();
    expect(summary?.sessionMissingKind).toBeUndefined();
    expect((await stores.jobs.listJobs()).find((j) => j.id === 'mgr-moved')?.runnerId).toBe(
      'runner-b',
    );
  });
});
