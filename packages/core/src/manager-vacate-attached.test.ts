import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerLiveness,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
} from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

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
    async select({ runnerId } = {}) {
      if (runnerId !== undefined) {
        const client = clients.get(runnerId);
        if (client === undefined) throw new Error(`この試験の偽物に無い runnerId: ${runnerId}`);
        return client;
      }
      const [first] = clients.values();
      if (first === undefined) throw new Error('runner が1台も無い（この試験群では使わない経路）');
      return first;
    },
    async register() {
      /* この試験群では使わない（`addClient` で直接足す）。 */
    },
    async unregister() {
      /* この試験群では使わない。 */
    },
    vacate(runnerId) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId) entry.state = 'vacating';
      }
    },
    entries() {
      return entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {
      /* この試験群では使わない（配置は検証対象ではない）。 */
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
): { client: RunnerClient; stopped: string[] } {
  const sessions = new Map<string, RunnerManagerState>();
  const stopped: string[] = [];
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この試験群は hello イベントの配送経路を使わない。 */
    },
    async start(command): Promise<{ cwd?: string }> {
      // 起こした瞬間にセッションを載せる: 空だと `sessionGone` 判定が「最初から居ない」で `true` になり、
      // 「確かめた停止」を試験したことにならない。
      sessions.set(command.managerId, {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
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
      stopped.push(managerId);
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
  return { client, stopped };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('ManagerPool.vacate() は確かめた停止の後に attached を訂正する', () => {
  it('移送先が無い drain のあと、runner にセッションが無いと確かめたら live: false になる', async () => {
    const stores = createMemoryStores();
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    const started = await pool.start({ request: '調べて', runnerId: 'runner-a' });
    const managerId = started.managerId;

    const before = (await pool.list()).find((s) => s.managerId === managerId);
    expect(before?.live).toBe(true);

    await pool.vacate('runner-a');

    expect(runnerA.stopped).toContain(managerId);
    expect(await runnerA.client.list()).toEqual([]);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === managerId);
    expect(job?.lease?.releasedAt).toBeDefined();

    const after = (await pool.list()).find((s) => s.managerId === managerId);
    expect(after?.live).toBe(false);

    await pool.stop();
  });
});
