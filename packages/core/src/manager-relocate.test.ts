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
import type { InboxEvent, Job, JobLease, WorkspaceLocator } from './schema.js';
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
      // コピーを返す: 呼び出し側（`manager.ts`）が返り値を書き換えないことを前提にしない。
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

describe('落ちた runner の委譲を、別の runner へ移送する（#485 M5 PR5）', () => {
  it('移送が成立する：runner-a が lost、runner-b が connected なら、runner-b が resume を受け、台帳の runnerId が runner-b になる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-1', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    pool.relocateFrom('runner-a');
    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-1');
    expect(job?.runnerId).toBe('runner-b');

    await pool.stop();
  });

  it('生きている宛先（connected）の仕事には resume を出さない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-2', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-2');
    expect(job?.runnerId).toBe('runner-a');

    await pool.stop();
  });

  it('名簿に runner-a の行が0本なら移送しない（「黙った」とまだ確かめられていない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-3', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);

    await pool.stop();
  });

  it('job.runnerId が無い古いジョブは移送しない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-4', undefined));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);

    await pool.stop();
  });

  it('貸し出しが生きていれば移送しない（held-by-lease。既存の関門がそのまま効く）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-5', 'runner-a', { lease: recentLease('runner-a') }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-5');
    expect(job?.runnerId).toBe('runner-a');
    expect(job?.lease?.fence).toBe(4);

    await pool.stop();
  });

  it('マネージャー向けの一言（restartNudge）が locator を読む：shared-volume は「中身は残っている」を含み、「走らせていた runner が黙った」で始まる', async () => {
    const stores = createMemoryStores();
    const workspace: WorkspaceLocator = { kind: 'shared-volume', path: '/mnt/shared' };
    await stores.jobs.putJob(jobWith('mgr-6', 'runner-a', { workspace }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const message = runnerB.resumes[0]?.message ?? '';
    expect(
      message.startsWith('[system] 走らせていた runner が黙ったので、別の器で続きを開いた。'),
    ).toBe(true);
    expect(message).toContain('中身は残っている');

    await pool.stop();
  });

  it('クローンの受信箱（manager_message/report）に「別の器で開き直した」が出る（#notifyRestored を通っている）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-7', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool, inbox } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const reports = inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('別の器で開き直した');

    await pool.stop();
  });

  it('relocateFrom は、落ちた宛先以外の connected な器へ取り直しを起こす（落ちた宛先自身には起こさない）', async () => {
    const stores = createMemoryStores();
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    fake.entries.push(entryOf('runner-d', 'unreachable', 'runner-d'));
    const runnerB = fakeRunner('runner-b');
    const runnerC = fakeRunner('runner-c');
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const { pool } = setup(stores, fake.registry);

    pool.relocateFrom('runner-a');
    await expect.poll(() => fake.gotten.length, { timeout: 2000 }).toBeGreaterThanOrEqual(2);

    expect(fake.gotten).toContain('runner-b');
    expect(fake.gotten).toContain('runner-c');
    expect(fake.gotten).not.toContain('runner-a');
    expect(fake.gotten).not.toContain('runner-d');

    await pool.stop();
  });

  it('名乗らないまま黙った宛先が名簿に在っても、job.runnerId が無い行は移送しない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-9', undefined));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('名乗らない宛先', 'lost'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);

    await pool.stop();
  });

  it('クローンへの報告に workspace の1行も出る：shared-volume なら「外へ保存していない作業も残っている」', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-10', 'runner-a', {
        workspace: { kind: 'shared-volume', path: '/mnt/shared/proj' },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool, inbox } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const reports = inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('別の器で開き直した');
    expect(reports[0]?.text).toContain('外へ保存していない作業も残っている');

    await pool.stop();
  });

  it('shared-volume の workspace なら、マネージャー向けの一言にもクローンへの報告にも、作り直させる文言は出ない（#1376）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-13', 'runner-a', {
        workspace: { kind: 'shared-volume', path: '/mnt/shared/proj' },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool, inbox } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const message = runnerB.resumes[0]?.message ?? '';
    expect(message).toContain('中身は残っている');
    expect(message).not.toContain('clone し直して');
    const reports = inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).not.toContain('作り直させること');

    await pool.stop();
  });

  it('git の workspace なら、マネージャー向けの一言が「clone し直してから、続きに入れ」と作り直す先を名指す（#1376）', async () => {
    const stores = createMemoryStores();
    const workspace: WorkspaceLocator = {
      kind: 'git',
      repository: 'https://github.com/example/proj.git',
      ref: 'feature/relocate',
    };
    await stores.jobs.putJob(jobWith('mgr-11', 'runner-a', { workspace }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const message = runnerB.resumes[0]?.message ?? '';
    expect(
      message.startsWith('[system] 走らせていた runner が黙ったので、別の器で続きを開いた。'),
    ).toBe(true);
    expect(message).toContain(
      'https://github.com/example/proj.git の feature/relocate を' +
        'clone し直してから、続きに入れ。',
    );
    expect(message).toContain('コミットしていなかった変更は残っていない');
    expect(message).not.toContain('中身は残っている');

    await pool.stop();
  });

  it('git の workspace なら、クローンへの報告の workspace の1行が「作り直させること」と「コミットしていなかった変更は残っていない」を出す（#1376）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-12', 'runner-a', {
        workspace: {
          kind: 'git',
          repository: 'https://github.com/example/proj.git',
          ref: 'feature/relocate',
        },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool, inbox } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const reports = inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('別の器で開き直した');
    expect(reports[0]?.text).toContain(
      'https://github.com/example/proj.git の feature/relocate から作り直させること。',
    );
    expect(reports[0]?.text).toContain('コミットしていなかった変更は残っていない');
    expect(reports[0]?.text).not.toContain('外へ保存していない作業も残っている');

    await pool.stop();
  });
});

describe('vacating な runner からの移送（#485 PR-1）', () => {
  it('移送が成立する：runner-a が vacating、runner-b が connected なら、runner-b が resume を受ける', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-vacating-1', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'vacating', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    pool.relocateFrom('runner-a');
    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacating-1');
    expect(job?.runnerId).toBe('runner-b');

    await pool.stop();
  });

  it('unreachable な宛先からは移送しない（lost / vacating の2値だけが移送の元）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-vacating-2', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'unreachable', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacating-2');
    expect(job?.runnerId).toBe('runner-a');

    await pool.stop();
  });
});

describe('ManagerPool.vacate（#485 PR-2）', () => {
  it('先に vacating を立ててから「確かめた停止」の握手をする（順序そのものが要点）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-vacate-order', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    const stateAtStop: (RunnerLiveness | undefined)[] = [];
    const originalStop = runnerA.client.stop;
    runnerA.client.stop = async (managerId: string) => {
      stateAtStop.push(fake.entries.find((entry) => entry.runnerId === 'runner-a')?.state);
      return originalStop(managerId);
    };

    await pool.vacate('runner-a');

    expect(stateAtStop).toEqual(['vacating']);

    await pool.stop();
  });

  // 移送先（runner-b）を登録しない: `relocateFrom` の対象が無いので、握手の直後の状態がそのまま観測できる。
  // `stopped` にしない: 終端にすると `#reattach()` の `status` の関門に引っかかり、二度と移送されなくなる。
  it('record.job.status を stopped にしない（移送先が無くても running のまま残る）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-vacate-nostop', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    await pool.vacate('runner-a');

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-nostop');
    expect(job?.status).toBe('running');

    await pool.stop();
  });

  // `instanceId` を lease と名簿の両方に同じ値で持たせる: `#confirmStoppedAndReleaseLease` の `sameHolder` の関門を通さないと release が起きない。
  it('貸し出しを先に返してあるので、relocateFrom は期限を待たずに移す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-vacate-lease', 'runner-a', {
        lease: { ...recentLease('runner-a'), instanceId: 'inst-a' },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push({ ...entryOf('runner-a', 'connected', 'runner-a'), instanceId: 'inst-a' });
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.vacate('runner-a');

    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-lease');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.status).toBe('running');

    await pool.stop();
  });

  // `lease.instanceId` も `entry.instanceId` も持たせない: `identity()` を実装しない runner（`LocalRunner` 等）の形。
  it('instanceId を名乗らない runner でも、vacate すれば貸し出しが解放される（Issue #1135）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-vacate-lease-unnamed', 'runner-a', {
        lease: recentLease('runner-a'),
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.vacate('runner-a');

    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-lease-unnamed');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.status).toBe('running');

    await pool.stop();
  });

  it('名簿に無い runnerId でも投げずに終わる', async () => {
    const stores = createMemoryStores();
    const fake = createFakeRegistry();
    const { pool } = setup(stores, fake.registry);

    await expect(pool.vacate('runner-ghost')).resolves.toStrictEqual({});

    await pool.stop();
  });
});
