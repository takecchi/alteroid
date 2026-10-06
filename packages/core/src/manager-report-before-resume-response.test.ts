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
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('同じ runner への復帰の最中に新しいセッションの report が先に届く（#3199 × #3159）', () => {
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
    // resume の応答が名乗るセッションの世代（Issue #3170）。省略は「名乗らない古い runner」。
    sessionGeneration?: string,
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
      async resume(command): Promise<{ cwd?: string; sessionGeneration?: string }> {
        resumes.push(command);
        sessions.set(command.managerId, {
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        return sessionGeneration === undefined ? {} : { sessionGeneration };
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

  it('resume の応答より先に新しい世代の report が届きており（このセッションで report は受け取った）、その後 closed(done) が来ても、「report を出さないまま終わった」を知らせない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-same', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a', '/work/project', 'gen-new');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      entered();
      await gate;
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    const clock = { now: Date.now() };
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
      now: () => clock.now,
      synthesizedNoticeWindowMs: 60_000,
    });
    await pool.abort('mgr-does-not-exist');
    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    // 新しいセッション（resume が作った gen-new）の report が、resume の HTTP 応答より先に届く。
    runnerA.emit?.({
      type: 'report',
      managerId: 'mgr-same',
      reportId: 'r-new',
      status: 'done',
      text: '新しいセッションの報告',
      sessionGeneration: 'gen-new',
    });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // 応答が遅れた（時計が進む）。
    clock.now += 5_000;
    release();
    await reattach;
    const before = inbox.length;
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-same',
      status: 'done',
      reason: '閉じた',
      sessionGeneration: 'gen-new',
    });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await pool.stop();
    const after = inbox.slice(before).map((e) => JSON.stringify(e));
    // 比較の足場: report 自体は受信箱へ届いている。
    expect(inbox.map((e) => JSON.stringify(e)).join('\n')).toContain('新しいセッションの報告');
    expect(after.join('\n')).not.toContain('report を出さないまま');
  });

  /**
   * 窓の間（resume の応答の前）に report を1本流し、応答を返して窓を閉じるまでを行う（#3234 の歯の足場）。
   * `resumeFails` なら応答は 503 で失敗する（受理されない）。実時間では待たない（#2146）。
   */
  async function reportInWindow(options: {
    resumeGeneration?: string;
    reportGeneration?: string;
    resumeFails?: boolean;
  }): Promise<{ job: Job | undefined; inboxText: string }> {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-same', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a', '/work/project', options.resumeGeneration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      entered();
      await gate;
      if (options.resumeFails === true) throw new RunnerHttpError('unavailable', 503);
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
      synthesizedNoticeWindowMs: 60_000,
    });
    await pool.abort('mgr-does-not-exist');
    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    runnerA.emit?.({
      type: 'report',
      managerId: 'mgr-same',
      reportId: 'r-window',
      status: 'running',
      text: '窓の間に届いた報告',
      ...(options.reportGeneration === undefined
        ? {}
        : { sessionGeneration: options.reportGeneration }),
    });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await pool.stop();
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
    return { job, inboxText: inbox.map((e) => JSON.stringify(e)).join('\n') };
  }

  it('(a) resume が受理された後、窓の間に届いた古い世代の report は lastReport を動かさず、受信箱にも出ない', async () => {
    const { job, inboxText } = await reportInWindow({
      resumeGeneration: 'gen-new',
      reportGeneration: 'gen-old',
    });
    // 比較の足場: 台帳は resume が受理された状態（running）で、元の lastReport が残っている。
    expect(job?.status).toBe('running');
    expect(job?.lastReport).toBe('途中まで進めた');
    expect(job?.lastReportAt).toBeUndefined();
    expect(inboxText).not.toContain('窓の間に届いた報告');
  });

  it('(a2) 世代を名乗らない古い runner の report は、受理された後に処理し直されて効く', async () => {
    const { job, inboxText } = await reportInWindow({});
    expect(job?.lastReport).toBe('窓の間に届いた報告');
    expect(job?.lastReportAt).toBeDefined();
    expect(inboxText).toContain('窓の間に届いた報告');
  });

  it('(b) resume が失敗したなら、窓の間に届いた report は従来どおり効く（預かって捨てない）', async () => {
    const { job, inboxText } = await reportInWindow({
      resumeGeneration: 'gen-new',
      reportGeneration: 'gen-old',
      resumeFails: true,
    });
    expect(job?.lastReport).toBe('窓の間に届いた報告');
    expect(inboxText).toContain('窓の間に届いた報告');
  });
});
