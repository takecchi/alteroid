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
  RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `ManagerPool.vacate()` は「確かめた停止」の後に `record.attached` を訂正する。かつては「確かめた停止」の
 * 握手（`#confirmStoppedAndReleaseLease`）で runner に生きたセッションが無いことを
 * 実際に確かめているのに、その委譲の `record.attached`（`ManagerRecord.attached` の
 * doc 逐語「runner に生きたセッションがあるか」）を訂正しない。
 *
 * `abort()` は同じ「確かめた停止」を経由した回に必ず `record.attached = false` を
 * 立てる（`manager.ts` の `abort()` 実装）。`#reattach` / `#restoreJobs` / `send()` も
 * 「runner がそのセッションを持っていない」と確かめた回はどれも `attached` を
 * 訂正している。**`vacate()` のジョブ走査だけが、この訂正を1箇所も持たない**
 * （`grep -Fn -- 'attached' packages/core/src/manager.ts` で vacate 本体の行域に
 * 訂正が無いことを確認できる）。
 *
 * 移送先が無い（drain したい runner が1台しか登録されていない）場合、
 * `relocateFrom()` は何もしないので、この委譲は `record.job.runnerId` が
 * vacate した runner を指したまま `#records` に残り続ける。この状態で
 * `pool.list()` を呼ぶと、`isLive()` は `record.attached` を読んで `live: true`
 * を返す —— **runner にセッションが無いと実際に確かめた直後にも関わらず**である。
 *
 * これは「回数では諦めない」系の一時的な遅延ではなく、影響が消えるまでの窓が
 * 無い——次に新しい runner が登録され `relocateFrom` が再び走らない限り、
 * `live: true` は貼り付いたままになる。
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
    async start(command) {
      // **本物と同じく、起こした瞬間にセッションを載せる。** ここが空だと
      // `vacate()` の `sessionGone` 判定（`runner.list()` に居ないか）が
      // 「最初から居ない」という別の理由で `true` になり、「確かめた停止」を
      // 試験したことにならない。
      sessions.set(command.managerId, {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
    },
    async resume(command) {
      sessions.set(command.managerId, {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
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

    // 前提: 起こした直後は生きたセッションとして扱われる。
    const before = (await pool.list()).find((s) => s.managerId === managerId);
    expect(before?.live).toBe(true);

    // runner-a を drain する。移送先（runner-b 等）は1台も登録していないので、
    // `relocateFrom()` は何もできず、この委譲は runner-a に紐づいたまま残る。
    await pool.vacate('runner-a');

    // **vacate は実際に runner.stop() を呼び、runner.list() でセッションが
    // 消えたことまで確かめている。** ここまでは正しく動いている——
    // fake runner の `stopped` にこの managerId が記録され、`list()` はもう
    // 何も返さない。
    expect(runnerA.stopped).toContain(managerId);
    expect(await runnerA.client.list()).toEqual([]);

    // 貸し出しも解放されている（「確かめた停止」の関門を通った証拠）。
    const job = (await stores.jobs.listJobs()).find((j) => j.id === managerId);
    expect(job?.lease?.releasedAt).toBeDefined();

    // ★ ここが本体。`ManagerRecord.attached` の doc は「runner に生きた
    // セッションがあるか」で、上で runner には確かにセッションが無いことを
    // 確かめてある。訂正する前は `isLive()` が `record.attached` の古い値
    // （`true`）をそのまま読み、`live: true` が貼り付いていた。
    const after = (await pool.list()).find((s) => s.managerId === managerId);
    expect(after?.live).toBe(false);

    await pool.stop();
  });
});
