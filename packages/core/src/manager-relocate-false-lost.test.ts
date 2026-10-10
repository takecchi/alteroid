import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type {
  RunnerAnswerCommand,
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
import type { InboxEvent, Job, JobLease } from './schema.js';
import { createMemoryStores } from './testing.js';

// 名簿が runner X を一時的に lost と誤判定しても（X は生きていて、委譲は確認を待っている）、移送の試みが生きている委譲を壊さないことを保証する（#4454）。
// 名簿は偽物で、`entries` の state と lastSeenAt を直に書き換えて lost / connected と「最後に名乗った時刻」を作る。

function entryOf(label: string, state: RunnerLiveness, runnerId: string): RunnerEntry {
  return {
    label,
    state,
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    lastSeenAt: new Date().toISOString(),
    revision: { status: 'unheard' },
  };
}

function createFakeRegistry() {
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
      throw new Error('使わない');
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
  return {
    registry,
    setState(runnerId: string, state: RunnerLiveness) {
      for (const entry of entries) if (entry.runnerId === runnerId) entry.state = state;
    },
    setLastSeen(runnerId: string, agoMs: number) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId)
          entry.lastSeenAt = new Date(Date.now() - agoMs).toISOString();
      }
    },
    add(client: RunnerClient) {
      clients.set(client.runnerId, client);
      entries.push(entryOf(client.runnerId, 'connected', client.runnerId));
    },
  };
}

interface Fake {
  client: RunnerClient;
  resumes: RunnerResumeCommand[];
  answers: RunnerAnswerCommand[];
  sends: string[];
  sessions: Map<string, RunnerManagerState>;
  emit(event: RunnerEvent): void;
}

function fakeRunner(runnerId: string): Fake {
  const resumes: RunnerResumeCommand[] = [];
  const answers: RunnerAnswerCommand[] = [];
  const sends: string[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  let emitter: ((event: RunnerEvent) => void) | undefined;
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent) {
      emitter = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
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
    async send(_id, message) {
      sends.push(message);
      return true;
    },
    async answer(managerId, answer): Promise<RunnerAnswerOutcome> {
      answers.push(answer);
      const session = sessions.get(managerId);
      return {
        delivered:
          session !== undefined && session.waiting.some((w) => w.requestId === answer.requestId),
      };
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
    async close() {},
  };
  return { client, resumes, answers, sends, sessions, emit: (event) => emitter?.(event) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await new Promise<void>((r) => setImmediate(r));
}

function leaseSeen(runnerId: string, ageMs: number): JobLease {
  const now = Date.now();
  return {
    runnerId,
    fence: 4,
    grantedAt: new Date(now - ageMs - 2_000).toISOString(),
    seenAt: new Date(now - ageMs).toISOString(),
    ttlMs: 10 * 60_000,
  };
}

/** X が確認待ち（ask を出して waiting_human）の委譲を持っている状態まで作る。`holderSeenAgoMs` は名簿が X の名乗りを最後に聞けてからの時間。 */
async function askingSetup(leaseAgeMs: number, holderSeenAgoMs = 1_000) {
  const stores = createMemoryStores();
  const job: Job = {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-x',
    lease: leaseSeen('runner-x', leaseAgeMs),
  };
  await stores.jobs.putJob(job);
  const fake = createFakeRegistry();
  const x = fakeRunner('runner-x');
  const y = fakeRunner('runner-y');
  fake.add(x.client);
  fake.add(y.client);
  fake.setLastSeen('runner-x', holderSeenAgoMs);
  x.sessions.set('mgr-1', {
    managerId: 'mgr-1',
    status: 'running',
    cwd: '/work/project',
    request: '続きをやって',
    waiting: [],
    sessionId: 'sess-1',
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (e) => inbox.push(e), runners: fake.registry });
  await pool.restore();
  await settle();
  // X 上のセッションが確認を出して待つ（runner 側の状態も waiting にしておく）。
  x.sessions.set('mgr-1', {
    managerId: 'mgr-1',
    status: 'waiting_human',
    cwd: '/work/project',
    request: '続きをやって',
    waiting: [{ requestId: 'req-1', summary: '本番へ出してよいか', kind: 'question' }],
    sessionId: 'sess-1',
  });
  x.emit({
    type: 'ask',
    managerId: 'mgr-1',
    requestId: 'req-1',
    kind: 'question',
    summary: '本番へ出してよいか',
  } as RunnerEvent);
  await settle();
  return { pool, stores, fake, x, y, inbox };
}

async function summaryOf(pool: Awaited<ReturnType<typeof askingSetup>>['pool']) {
  return (await pool.list()).find((m) => m.managerId === 'mgr-1');
}

/** 名簿が X を lost と誤判定して移送を試み、X が名乗り直して connected に戻るまで。 */
async function falseLostAndBack(setup: Awaited<ReturnType<typeof askingSetup>>) {
  setup.fake.setState('runner-x', 'lost');
  setup.pool.relocateFrom('runner-x');
  await settle();
  setup.fake.setState('runner-x', 'connected');
  await setup.pool.reattachRunner('runner-x');
  await settle();
}

describe('名簿の誤った lost の間の移送の試みが、生きている委譲を壊さない（#4454）', () => {
  it('前提: ask の後、委譲は waiting_human で、どの器にも resume は撃たれていない', async () => {
    const { pool, x, y } = await askingSetup(1_000);
    expect((await summaryOf(pool))?.status).toBe('waiting_human');
    expect(x.resumes).toHaveLength(0);
    expect(y.resumes).toHaveLength(0);
    await pool.stop();
  });

  it('貸し出しで断られた移送の後も、確認への回答が X へ届く（待っていた確認を消さない）', async () => {
    const setup = await askingSetup(1_000);
    await falseLostAndBack(setup);
    const result = await setup.pool.send('mgr-1', '出してよい', {
      requestId: 'req-1',
      decision: 'allow',
    });
    expect(result.outcome).toBe('answered');
    expect(setup.x.answers).toHaveLength(1);
    expect(setup.y.resumes).toHaveLength(0);
    await setup.pool.stop();
  });

  it('貸し出しで断られた移送の後の manager_send は、X の生きたセッションへ resume を撃ち直さない', async () => {
    const setup = await askingSetup(1_000);
    await falseLostAndBack(setup);
    await setup.pool.send('mgr-1', '追加の指示');
    expect(setup.x.resumes).toHaveLength(0);
    expect(setup.y.resumes).toHaveLength(0);
    expect(setup.x.sends).toHaveLength(1);
    await setup.pool.stop();
  });

  it('断られた移送は、像を「器にセッションが無い」側へ倒さない', async () => {
    const setup = await askingSetup(1_000);
    setup.fake.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    const summary = await summaryOf(setup.pool);
    expect(summary?.sessionMissingSince).toBeUndefined();
    expect(setup.y.resumes).toHaveLength(0);
    await setup.pool.stop();
  });

  it('台帳の seenAt が10分30秒より古くても、X の名乗りを最近聞けていれば Y で起こさない（二重実行にしない）', async () => {
    const setup = await askingSetup(11 * 60_000, 2_000);
    setup.fake.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(0);
    const job = (await setup.stores.jobs.listJobs()).find((j) => j.id === 'mgr-1');
    expect(job?.runnerId).toBe('runner-x');
    expect(job?.lease?.runnerId).toBe('runner-x');
    await setup.pool.stop();
  });

  it('X の名乗りも10分30秒以上聞けていなければ、これまでどおり Y へ移す（本当に落ちた器の委譲は取り残さない）', async () => {
    const setup = await askingSetup(11 * 60_000, 11 * 60_000);
    setup.fake.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(1);
    const job = (await setup.stores.jobs.listJobs()).find((j) => j.id === 'mgr-1');
    expect(job?.runnerId).toBe('runner-y');
    await setup.pool.stop();
  });
});
