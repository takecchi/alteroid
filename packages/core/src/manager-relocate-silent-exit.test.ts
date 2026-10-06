import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { RunnerHttpError } from './runner-protocol.js';
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
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 移送の候補の `#reattach` が resume を投げずに黙って抜ける分岐の再現（Issue #3103）。
 *
 * `workspace-path-unknown`（`job.cwd` が無く、候補が `workspacePath` を聞けていない）は
 * `#reattach` の `if (outcome !== 'resumed') continue;` で抜け、`retry` も立てず lost にもしない。
 * 台帳は `running` / 元の宛先のまま残り、梯子の予約も無いので、誰もこの委譲を拾わない。
 * 期待（赤になる側）は「候補が尽きたら lost に確定する」（#3098 の断った runner と同じ扱い）。
 *
 * 時間はフェイクタイマーで進める（実時間の待ちは使わない）。
 */

/** 名簿の1行を組み立てる（`RunnerEntry` の必須欄はここで埋める）。 */
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
 * `RunnerRegistry` の9メンバを満たす偽物。**この試験群で使うのは `get` /
 * `entries` の2つだけ**（`#reattach` が実際に読むのはこの2つである）。残りは
 * 型を満たすだけで、呼ばれたら「使わない」と分かる形にしてある。
 *
 * **`vacate` だけは「使わない」にしていない。** 本物（`Registry#vacate`）と
 * 同じ効果（`entries` の該当行を `'vacating'` へ倒す）を持たせてある——
 * `ManagerPool.vacate()`（#485 PR-2）を試験するとき、`fake.entries.push` で
 * 手で先に `'vacating'` を置く形と、`pool.vacate()` を呼んで名簿側から
 * 倒させる形の両方を、同じ偽物で試せるようにするためである。
 */
function createFakeRegistry(): {
  registry: RunnerRegistry;
  /** 試験ごとに push / state 書き換えで差し替える。 */
  entries: RunnerEntry[];
  /** `get(runnerId)` が返す `RunnerClient` を登録する。 */
  addClient: (client: RunnerClient) => void;
  /** `get()` に渡された runnerId を呼ばれた順に記録する（#8 の検証用）。 */
  gotten: string[];
} {
  const clients = new Map<string, RunnerClient>();
  const entries: RunnerEntry[] = [];
  const gotten: string[] = [];
  const registry: RunnerRegistry = {
    async list() {
      return [...clients.values()];
    },
    async get(runnerId) {
      gotten.push(runnerId);
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
      // **試験が直接 push / 変異させた行を、呼ばれるたびに読み直す。** コピーを
      // 返すのは、呼び出し側（`manager.ts`）が返り値を書き換えないことを
      // 前提にしないためである。
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
    gotten,
  };
}

/**
 * 偽の `RunnerClient`。`swappableRunner`（`manager-workspace-nudge.test.ts`）・
 * `LeasedRunner`（`manager-lease.test.ts`）と同じ形。
 */
function fakeRunner(
  runnerId: string,
  workspacePath = '/work/project',
): { client: RunnerClient; resumes: RunnerResumeCommand[] } {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この試験群は hello イベントの配送経路を使わない（`reattachRunner` /
       * `relocateFrom` が直に `#reattach` を起こす）。 */
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
  return { client, resumes };
}

/** 走行中の委譲を組み立てる。`runnerId` は台帳の記録した宛先。 */
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

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

/** 梯子（最大30秒間隔）が何回回っても足りる時間。フェイクタイマーなので実時間は掛からない。 */
const LADDER_MS = 10 * 60_000;

describe('移送の候補が resume を投げずに抜けると、委譲が running のまま誰にも引き取られない（#3103）', () => {
  async function jobOf(stores: ReturnType<typeof createMemoryStores>, id: string) {
    return (await stores.jobs.listJobs()).find((j) => j.id === id);
  }

  it('候補 b が workspace-path-unknown で抜けたあと、梯子を回しても b は二度と試されず、委譲は running のまま残る', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      // cwd を持たない委譲（`workspace-path-unknown` は cwd が無いときだけ立つ）。
      await stores.jobs.putJob(jobWith('mgr-silent', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      const runnerB = fakeRunner('runner-b');
      // b は hello で workspacePath を聞けていない。
      runnerB.client.workspacePathKnown = false;
      runnerB.client.workspacePath = '';
      fake.addClient(runnerB.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      const getsAfterFirst = fake.gotten.length;
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-silent');
      // 観測（いまの振る舞い）: resume は投げず、梯子も予約されず。
      expect({
        resumesOnB: runnerB.resumes.length,
        retriedAfterExit: fake.gotten.length - getsAfterFirst,
      }).toEqual({ resumesOnB: 0, retriedAfterExit: 0 });
      // 期待（赤）: 候補が b だけで、b が引き取れないと分かったのだから、running のまま放置せず
      // lost に確定する（#3098 の「断った runner」と同じ扱い）。
      expect({ status: job?.status, runnerId: job?.runnerId }).toEqual({
        status: 'lost',
        runnerId: 'runner-a',
      });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('b が 4xx で断り、c が workspace-path-unknown で抜けると、候補が尽きたと数えられず running のまま残る（#3098 との合わせ技）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-silent-c', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      runnerB.client.resume = async () => {
        throw new RunnerHttpError('forbidden (runner-b 固有の設定)', 403);
      };
      const runnerC = fakeRunner('runner-c');
      runnerC.client.workspacePathKnown = false;
      runnerC.client.workspacePath = '';
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool } = setup(stores, fake.registry);

      // b が先に断る（c が残っているので、いまの実装は確定しない）。
      await pool.reattachRunner('runner-b');
      // 予約された c の取り直し（と、起こしうる梯子）をすべて回す。
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-silent-c');
      expect(runnerC.resumes.length).toBe(0);
      // 期待（赤）: b は断り、c は引き取れない。全員が引き取れないのだから lost に確定する。
      expect(job?.status).toBe('lost');
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 日誌の全文（decision と exchange）。 */
async function journalTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  return (await stores.journal.list({ limit: 500 })).map((entry) =>
    entry.type === 'decision' ? `${entry.decision}\n${entry.grounds}` : JSON.stringify(entry),
  );
}

describe('移送で引き取れない抜け方をした候補の扱い（#3103 案 A）', () => {
  async function jobOf(stores: ReturnType<typeof createMemoryStores>, id: string) {
    return (await stores.jobs.listJobs()).find((j) => j.id === id);
  }

  it('(a) b が workspace-path-unknown で抜けても、ほかの候補 c が受ければ c へ移る（lost にしない）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-a', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      runnerB.client.workspacePathKnown = false;
      runnerB.client.workspacePath = '';
      const runnerC = fakeRunner('runner-c');
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      // b は引き取れない。c が残っているので lost に確定せず、c へ任せる。
      expect((await jobOf(stores, 'mgr-a'))?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-a');
      expect({
        resumesOnB: runnerB.resumes.length,
        resumesOnC: runnerC.resumes.length,
        status: job?.status,
        runnerId: job?.runnerId,
      }).toEqual({ resumesOnB: 0, resumesOnC: 1, status: 'running', runnerId: 'runner-c' });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(b) 移送のときの no-session は候補を回さずその場で lost になり、日誌とクローンへの知らせに理由が入る', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-ns', 'runner-a', { sessionId: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      // 残りの候補 c が居ても待たない。
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      const runnerC = fakeRunner('runner-c');
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool, inbox } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-ns');
      expect({
        status: job?.status,
        resumes: runnerB.resumes.length + runnerC.resumes.length,
      }).toEqual({
        status: 'lost',
        resumes: 0,
      });
      const texts = await journalTexts(stores);
      expect(
        texts.some((t) => t.includes('no-session') && t.includes('どの runner でも開き直せない')),
      ).toBe(true);
      const notices = inbox.flatMap((event) =>
        event.type === 'manager_message' ? [event.text] : [],
      );
      expect(notices.some((t) => t.includes('no-session'))).toBe(true);
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) 移送ではない復帰（宛先が名乗り直した）の no-session と workspace-path-unknown は従来どおり lost にしない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-ns-home', 'runner-a', { sessionId: undefined }));
      await stores.jobs.putJob(jobWith('mgr-wpu-home', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
      const runnerA = fakeRunner('runner-a');
      runnerA.client.workspacePathKnown = false;
      runnerA.client.workspacePath = '';
      fake.addClient(runnerA.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-a');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      expect({
        ns: (await jobOf(stores, 'mgr-ns-home'))?.status,
        wpu: (await jobOf(stores, 'mgr-wpu-home'))?.status,
        resumes: runnerA.resumes.length,
      }).toEqual({ ns: 'running', wpu: 'running', resumes: 0 });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('併存を関門より前で検出して見送った候補も断りとして数え、候補が尽きたら lost に確定する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-dup', 'runner-a'));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      // 同じ runnerId を名乗る器が2台（併存）。
      fake.entries.push(entryOf('http://b-1', 'connected', 'runner-b'));
      fake.entries.push(entryOf('http://b-2', 'connected', 'runner-b'));
      const runnerB = fakeRunner('runner-b');
      fake.addClient(runnerB.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');

      expect({
        status: (await jobOf(stores, 'mgr-dup'))?.status,
        resumes: runnerB.resumes.length,
      }).toEqual({ status: 'lost', resumes: 0 });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
