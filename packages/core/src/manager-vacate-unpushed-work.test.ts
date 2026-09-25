import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerLiveness,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
  RunnerResumeCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobLease } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **`pool.vacate(runnerId)` の委譲ごとのループで、`runner.stop()` の直前に
 * 未 push の観測を1回取って記録すること（Issue #1266 候補(2)。`vacate()`
 * 自体は #485 PR-2 / #1453 / #1472）。**
 *
 * 足場（`entryOf` / `createFakeRegistry` / `fakeRunner` / `jobWith` /
 * `recentLease` / `setup`）は `manager-relocate.test.ts` の
 * `describe('ManagerPool.vacate（#485 PR-2）')` と同じ形を複製してある
 * （同ファイルの doc と同じ理由——duplicated on purpose）。`unpushedWork()` を
 * 実装して呼び出し順序を記録できる点だけが違う。
 *
 * ⚠️ **これが効くのは、runner を意図して空けるとき（drain。`vacate()` を実際に
 * 呼んだとき）だけである。** 日常の Railway redeploy はプロセスごと差し替わる
 * だけで `vacate()`（`POST /runners/vacate`）を誰も呼ばない
 * （`railway/README.md`「デプロイは走行中の仕事を畳む操作である」）——この
 * 歯はその区別までは固定していない（固定しているのは `vacate()` 自身が
 * 呼ばれたときの配線）。
 *
 * ## 測る2つ
 *
 * 1. `unpushedWork()` が `runner.stop()` より前に呼ばれ、観測が台帳
 *    （`job.lastUnpushedWorkObservation`）に残る
 * 2. 観測（runner 側の応答）が失敗しても、vacate 本体の判定
 *    （`#confirmStoppedAndReleaseLease` の確かめた停止・貸し出しの解放・
 *    移送）は変わらない
 */

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
    vacate(runnerId) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId) entry.state = 'vacating';
      }
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
): { client: RunnerClient; resumes: RunnerResumeCommand[] } {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, { managerId: string }>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この試験群では使わない。 */
    },
    async start() {
      /* この試験群では使わない。 */
    },
    async resume(command) {
      resumes.push(command);
      sessions.set(command.managerId, { managerId: command.managerId });
    },
    async send() {
      /* この試験群では使わない。 */
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      sessions.delete(managerId);
    },
    async list() {
      return [...sessions.values()].map((s) => ({
        managerId: s.managerId,
        status: 'running' as const,
        cwd: workspacePath,
        request: '続きをやって',
        waiting: [],
      }));
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
  // **最初から `runningId` のセッションを1本持たせておく**（`vacate()` の
  // ループが `runner.stop()` を呼ぶ対象がいる状態を作る）。
  sessions.set('__seed__', { managerId: '__seed__' });
  sessions.delete('__seed__');
  return { client, resumes };
}

function jobWith(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-before-vacate',
    lastReport: '途中まで進めた',
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

function recentLease(runnerId: string, fence = 4): JobLease {
  const now = Date.now();
  return {
    runnerId,
    fence,
    grantedAt: new Date(now - 2_000).toISOString(),
    seenAt: new Date(now - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
  };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('vacate が runner.stop() の直前に unpushedWork() を取る（Issue #1266 候補(2)）', () => {
  it('1. runner.stop() より前に unpushedWork() が呼ばれ、観測が台帳に残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-vacate-unpushed', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    // `vacate()` のループは「走っているもの」だけに握手する——`resume` した
    // セッションが `list()` に載っていないと `stop()` へ辿り着かない
    // （`sessions.set` 経由。ここでは直接呼び出し順序を測りたいので、
    // `resume` を経由せず `runner.stop()` を呼ぶ前提を素直に満たす）。
    await runnerA.client.resume({
      managerId: 'mgr-vacate-unpushed',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-vacate',
    });

    const calls: string[] = [];
    const result: UnpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/vacate-observed-before-stop' }],
    };
    runnerA.client.unpushedWork = async (managerId) => {
      calls.push(`unpushedWork:${managerId}`);
      return result;
    };
    const originalStop = runnerA.client.stop;
    runnerA.client.stop = async (managerId: string) => {
      calls.push(`stop:${managerId}`);
      return originalStop(managerId);
    };
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    await pool.vacate('runner-a');

    // **順序そのものが要点。** `unpushedWork` が `stop` より先に呼ばれている
    // ——生きて答えられる最後の機会に取ることを固定する。
    expect(calls).toEqual(['unpushedWork:mgr-vacate-unpushed', 'stop:mgr-vacate-unpushed']);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-unpushed');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/vacate-observed-before-stop' }],
    });

    await pool.stop();
  });

  it('2. unpushedWork() の応答が失敗しても、確かめた停止・貸し出しの解放・移送は変わらない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-vacate-unpushed-fail', 'runner-a', {
        lease: { ...recentLease('runner-a'), instanceId: 'inst-a' },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push({ ...entryOf('runner-a', 'connected', 'runner-a'), instanceId: 'inst-a' });
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    await runnerA.client.resume({
      managerId: 'mgr-vacate-unpushed-fail',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-vacate',
    });
    // **runner 側の応答が失敗する形**（session が答えない・往復が失敗する等の
    // 代表として、例外を投げる）。
    runnerA.client.unpushedWork = async () => {
      throw new Error('runner が答えなかった');
    };
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.vacate('runner-a');

    // **移送は普通に起きる**——観測の失敗が `#confirmStoppedAndReleaseLease` /
    // `relocateFrom` を巻き添えにしていない。
    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-unpushed-fail');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.status).toBe('running');
    // **観測そのものは「取れなかった」として台帳に残る**——`unpushedWork()` は
    // 例外を投げない設計なので、失敗しても `kind:'unavailable'` に畳まれて
    // 記録される（欄が消えるのではない）。
    expect(job?.lastUnpushedWorkObservation).toMatchObject({ kind: 'unavailable' });

    await pool.stop();
  });
});
