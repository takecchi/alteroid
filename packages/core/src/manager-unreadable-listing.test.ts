import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerLiveness,
  RunnerManagerListing,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
} from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **状態を読めなかったが runner に居る委譲を、Pool は「居ない」と畳まない**（Issue #1661）。
 *
 * runner が先に新しい版になって、デーモンのまだ知らない `status` を送る版ずれでは、
 * その委譲は `HttpRunner#list()` のスキーマに落ちる。以前の Pool は落ちた委譲を
 * 「runner に居ない」と読み、まだ走っている委譲の貸し出しを返し
 * （`#confirmStoppedAndReleaseLease`）、起動時には resume して待っていた確認を捨てて
 * いた（`#restoreJobs`）。いまは `RunnerClient.listWithUnreadable` が返す
 * `unreadableIds` も「居る」側に数える。
 *
 * 偽の runner は、`skewed` に入れた委譲を `list()` から外し、`listWithUnreadable()` の
 * `unreadableIds` にだけ名乗る——`HttpRunner` が版ずれで見せる形そのものである。
 */

/** 名簿の1行を組み立てる（`manager-relocate.test.ts` の同名ヘルパと同じ形）。 */
function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
  return {
    label,
    state,
    ...(runnerId === undefined ? {} : { runnerId }),
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

/**
 * `RunnerRegistry` の偽物。`manager-relocate.test.ts` の `createFakeRegistry` と
 * 同じ骨格だが、`select()` も実装する（`pool.start()` を実際に通すため——
 * あちらの試験群は `start()` を使わないので `select` を「使わない」で塞いでいる）。
 */
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
      // 本物（`Registry#vacate`）と同じ効果 —— 一致する行を 'vacating' へ倒す。
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

/** 偽の `RunnerClient`（`manager-relocate.test.ts` の同名ヘルパの縮小版）。 */
/** 版ずれを模せる偽の `RunnerClient`。 */
function skewableRunner(runnerId: string): {
  client: RunnerClient;
  skewed: Set<string>;
  resumed: string[];
  failStop: { value: boolean };
} {
  const sessions = new Map<string, RunnerManagerState>();
  const skewed = new Set<string>();
  const resumed: string[] = [];
  const failStop = { value: false };
  const readable = () => [...sessions.values()].filter((s) => !skewed.has(s.managerId));
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect() {},
    async start(command) {
      sessions.set(command.managerId, {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
    },
    async resume(command) {
      resumed.push(command.managerId);
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      // 止める RPC が失敗した回を模す（セッションは runner に残る）。
      if (failStop.value) throw new Error('stop の RPC が失敗した（試験の偽物）');
      sessions.delete(managerId);
    },
    async list() {
      return readable();
    },
    async listWithUnreadable(): Promise<RunnerManagerListing> {
      return {
        states: readable(),
        unreadableIds: [...sessions.keys()].filter((id) => skewed.has(id)),
      };
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
  return { client, skewed, resumed, failStop };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('状態を読めなかったが runner に居る委譲を「居ない」と畳まない（#1661）', () => {
  it('止める RPC が失敗し、委譲が読めないまま runner に居るなら、止まったと言わず貸し出しも返さない', async () => {
    const stores = createMemoryStores();
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = skewableRunner('runner-a');
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    const { managerId } = await pool.start({ request: '調べて', runnerId: 'runner-a' });
    runnerA.skewed.add(managerId);
    runnerA.failStop.value = true;

    const result = await pool.abort(managerId);

    expect(result.outcome).not.toBe('stopped');
    const job = (await stores.jobs.listJobs()).find((j) => j.id === managerId);
    expect(job?.lease?.releasedAt).toBeUndefined();
    await pool.stop();
  });

  it('デーモンを作り直したとき、読めないまま runner に居る委譲を resume しない', async () => {
    const stores = createMemoryStores();
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = skewableRunner('runner-a');
    fake.addClient(runnerA.client);
    const first = setup(stores, fake.registry);
    const { managerId } = await first.pool.start({ request: '調べて', runnerId: 'runner-a' });
    await first.pool.stop();

    // 台帳にはセッション id が在る（本物の runner は init の合図で名乗る。
    // `#restoreJobs` は id の無い委譲を resume しないので、ここで置く）。
    const job = (await stores.jobs.listJobs()).find((j) => j.id === managerId);
    if (job === undefined) throw new Error('台帳に委譲が無い');
    await stores.jobs.putJob({ ...job, sessionId: 'sess-previous' });

    // デーモンだけが作り直され、runner は先に新しい版になっていた。
    runnerA.skewed.add(managerId);
    const second = setup(stores, fake.registry);
    await second.pool.restore();

    expect(runnerA.resumed).not.toContain(managerId);
    const summary = (await second.pool.list()).find((s) => s.managerId === managerId);
    expect(summary).toBeDefined();
    await second.pool.stop();
  });
});
