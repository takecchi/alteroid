import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  raw(event: RunnerEvent): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  const deliver = (raw: RunnerEvent): void => {
    // 境界（runnerEventSchema.safeParse）を実際に通す: スキーマに無い欄はここで落ちるため。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  };

  return {
    runner,
    alive,
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      deliver({ type: 'closed', managerId, status, reason });
    },
    raw: deliver,
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  clock: { now: number };
}

async function runningManualSetup(
  managerId: string,
  jobOverrides: Partial<Job> = {},
  existingStores?: Stores,
): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
    ...jobOverrides,
  };
  const stores = existingStores ?? createMemoryStores();
  if (existingStores === undefined) await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const clock = { now: Date.now() };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock.now,
    // 既定 3000ms より大きく取る: 実時間で窓が閉じないようにし、閉じるのは `pool.stop()` の flush だけにする。
    synthesizedNoticeWindowMs: 60_000,
  });

  await pool.restore();
  await settle();

  return { pool, stores, inbox, fake, clock };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

const SESSION_CLOSED = 'マネージャーのセッションが閉じた。';

function noticesAbout(inbox: readonly InboxEvent[], from: number, managerId: string): string[] {
  return inbox
    .slice(from)
    .filter((e) => e.type === 'manager_message' && e.managerId === managerId)
    .map((e) => JSON.stringify(e));
}

function reportOf(managerId: string, extra: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    type: 'report',
    managerId,
    reportId: `r-${managerId}`,
    status: 'done',
    text: '調べ終わった。',
    ...extra,
  } as RunnerEvent;
}

describe('report 無しの closed(done)（#3189）', () => {
  it('report 無しで closed(done) だけが届いたとき、クローンの受信箱に委譲が終わったことが出る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-done');
    const before = inbox.length;
    fake.closed('mgr-done', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    expect(inbox.slice(before)).not.toHaveLength(0);
  });

  it('知らせは委譲の id・report が無いまま終わったこと・成果を確かめる必要があることを言う', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-done');
    const before = inbox.length;
    fake.closed('mgr-done', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    const notices = noticesAbout(inbox, before, 'mgr-done');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('mgr-done');
    expect(notices[0]).toContain('report を出さないまま');
    expect(notices[0]).toContain('確かめること');
  });

  it('(a) このセッションで report が届いた後の closed(done) は、今までどおり受信箱に何も足さない', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-after-report');
    fake.raw({ type: 'session', managerId: 'mgr-after-report', sessionId: 'sess-1' });
    await settle();
    fake.raw(reportOf('mgr-after-report'));
    await settle();
    const beforeClosed = inbox.length;
    // 比較の足場: report 自体は受信箱へ届いている（0件同士の比較にしない）。
    expect(noticesAbout(inbox, 0, 'mgr-after-report').join('')).toContain('調べ終わった。');
    fake.closed('mgr-after-report', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    expect(inbox.slice(beforeClosed)).toHaveLength(0);
  });

  it('(a) report の後に新しいセッションが置かれて、そこで report が無いまま閉じたときは知らせる', async () => {
    const { pool, inbox, fake, clock } = await runningManualSetup('mgr-new-session');
    fake.raw({ type: 'session', managerId: 'mgr-new-session', sessionId: 'sess-1' });
    await settle();
    fake.raw(reportOf('mgr-new-session'));
    await settle();
    clock.now += 60 * 60 * 1000;
    fake.raw({ type: 'session', managerId: 'mgr-new-session', sessionId: 'sess-2' });
    await settle();
    const before = inbox.length;
    fake.closed('mgr-new-session', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    expect(noticesAbout(inbox, before, 'mgr-new-session')).toHaveLength(1);
  });

  it('(#3198) 同じセッションの2ターン目が report 無しで closed(done) になったら、1ターン目に report があっても知らせる', async () => {
    const { pool, stores, inbox, fake, clock } = await runningManualSetup('mgr-turn2-silent');
    fake.raw({ type: 'session', managerId: 'mgr-turn2-silent', sessionId: 'sess-1' });
    await settle();
    fake.raw(reportOf('mgr-turn2-silent'));
    await settle();
    clock.now += 60 * 60 * 1000;
    const sent = await pool.send('mgr-turn2-silent', '続きをお願い');
    expect(sent.outcome).toBe('delivered');
    const persisted = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-turn2-silent');
    expect(persisted?.turnStartedAt).toBe(new Date(clock.now).toISOString());
    const before = inbox.length;
    fake.closed('mgr-turn2-silent', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    const notices = noticesAbout(inbox, before, 'mgr-turn2-silent');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('report を出さないまま');
  });

  it('(#3198) 2ターン目にも report があれば、closed(done) は今までどおり無音', async () => {
    const { pool, inbox, fake, clock } = await runningManualSetup('mgr-turn2-reported');
    fake.raw({ type: 'session', managerId: 'mgr-turn2-reported', sessionId: 'sess-1' });
    await settle();
    fake.raw(reportOf('mgr-turn2-reported'));
    await settle();
    clock.now += 60 * 60 * 1000;
    const sent = await pool.send('mgr-turn2-reported', '続きをお願い');
    expect(sent.outcome).toBe('delivered');
    clock.now += 60 * 1000;
    fake.raw(reportOf('mgr-turn2-reported', { reportId: 'r-turn2' } as Partial<RunnerEvent>));
    await settle();
    const beforeClosed = inbox.length;
    // 比較の足場: report 自体は受信箱へ届いている（0件同士の比較にしない）。
    expect(noticesAbout(inbox, 0, 'mgr-turn2-reported').join('')).toContain('調べ終わった。');
    fake.closed('mgr-turn2-reported', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    expect(inbox.slice(beforeClosed)).toHaveLength(0);
  });

  it('(b) 背景処理の積みがあるときは、積みの知らせ1本だけで、report 無しの知らせを重ねない', async () => {
    const { pool, inbox, fake, clock } = await runningManualSetup('mgr-withheld');
    fake.raw({ type: 'session', managerId: 'mgr-withheld', sessionId: 'sess-1' });
    await settle();
    fake.raw(
      reportOf('mgr-withheld', {
        awaitingBackground: { count: 1, breakdown: 'ビルド1本' },
      } as Partial<RunnerEvent>),
    );
    await settle();
    clock.now += 60 * 60 * 1000;
    fake.raw({ type: 'session', managerId: 'mgr-withheld', sessionId: 'sess-2' });
    await settle();
    const before = inbox.length;
    fake.closed('mgr-withheld', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    const notices = noticesAbout(inbox, before, 'mgr-withheld');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('背景処理の完了待ちで畳んでいた報告をまとめて配る');
    expect(notices[0]).not.toContain('report を出さないまま');
  });

  it('(a) デーモンを作り直した後でも、再起動の前に report を受け取っていれば、report 無しの closed(done) は無音', async () => {
    const first = await runningManualSetup('mgr-restart');
    first.fake.raw({ type: 'session', managerId: 'mgr-restart', sessionId: 'sess-1' });
    await settle();
    first.fake.raw(reportOf('mgr-restart'));
    await settle();
    await first.pool.stop();
    const persisted = (await first.stores.jobs.listJobs()).find((j) => j.id === 'mgr-restart');
    expect(persisted?.runnerSessionSince).toBeDefined();
    expect(persisted?.lastReportAt).toBeDefined();

    const second = await runningManualSetup('mgr-restart', {}, first.stores);
    const before = second.inbox.length;
    second.fake.closed('mgr-restart', 'done', SESSION_CLOSED);
    await settle();
    await second.pool.stop();
    expect(noticesAbout(second.inbox, before, 'mgr-restart')).toHaveLength(0);
  });

  it('(c) 判定できないとき（器がセッションを置いた時刻が無く、report の記録だけが在る）は、無音へ倒さず知らせる', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-unknown', {
      lastReportAt: '2026-09-02T00:00:00.000Z',
    });
    const before = inbox.length;
    fake.closed('mgr-unknown', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    const notices = noticesAbout(inbox, before, 'mgr-unknown');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('判定できなかった');
  });

  it('(c) 判定できないとき（lastReportAt が日時として読めない）も、無音へ倒さず知らせる', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-garbled', {
      lastReportAt: 'いつか',
    });
    fake.raw({ type: 'session', managerId: 'mgr-garbled', sessionId: 'sess-1' });
    await settle();
    const before = inbox.length;
    fake.closed('mgr-garbled', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    const notices = noticesAbout(inbox, before, 'mgr-garbled');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('判定できなかった');
  });

  it('closed(failed) の知らせは変わらない（report 無しの done の知らせを failed へ広げていない）', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-failed');
    const before = inbox.length;
    fake.closed('mgr-failed', 'failed', 'マネージャーのセッションが落ちた: Error: boom');
    await settle();
    await pool.stop();
    const notices = noticesAbout(inbox, before, 'mgr-failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('boom');
    expect(notices[0]).not.toContain('report を出さないまま');
  });
});
