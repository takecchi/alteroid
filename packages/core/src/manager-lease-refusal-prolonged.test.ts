import { afterEach, describe, expect, it, vi } from 'vitest';

import { recentDroppedTraces, setStderrSinkForTesting } from './dropped-record.js';
import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import type { RunnerClient, RunnerEntry, RunnerManagerState } from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job, JobLease } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 貸し出しの関門の断り（`held`・`persist-failed`）が長引いたとき、クローンの受信箱へ1回だけ知らせる（A3）。
// 梯子（30 秒間隔・回数制限なし）が回り続けることは変えない。ここが縛るのは「知らせの出方」だけ。
// 実時間は使わない（fake timer）。閾値は定数 `LEASE_REFUSAL_PROLONGED_MS`（15 分）。値そのものも縛るため、ここへ字面で置く。
const PROLONGED_MS = 15 * 60_000;
const MINUTE = 60_000;

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

const PROLONGED = /貸し出しの関門に断られ続けている/;
const RESOLVED = /貸し出しの関門を通った/;

function entryOf(runnerId: string, overrides: Partial<RunnerEntry> = {}): RunnerEntry {
  return {
    label: runnerId,
    state: 'connected',
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
    ...overrides,
  };
}

function jobOf(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-a',
    ...overrides,
  };
}

/** 別の器（`runner-other`）が握っている貸し出し。`seenAt` から `ttlMs + 30 秒` の間 `held`。 */
function heldLease(ttlMs: number): JobLease {
  return {
    runnerId: 'runner-other',
    instanceId: 'boot-1',
    fence: 4,
    grantedAt: new Date(CLOCK - 2_000).toISOString(),
    seenAt: new Date(CLOCK - 1_000).toISOString(),
    ttlMs,
  };
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  resumeTimes: number[];
  sessions: Map<string, RunnerManagerState>;
  /** 真の間、`putJob` が投げる（`persist-failed` を作る）。 */
  setBroken: (broken: boolean) => void;
  /** 真の間、受信箱への `post` が「長引き」の知らせだけ投げる（通知の失敗が関門を変えないことを見る）。 */
  setPostThrows: (throws: boolean) => void;
}

async function build(
  options: { jobs?: Job[]; entries?: RunnerEntry[]; broken?: boolean } = {},
): Promise<Env> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(CLOCK);
  const resumeTimes: number[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client: RunnerClient = fakeRunnerClient({
    runnerId: 'runner-a',
    async resume(command) {
      resumeTimes.push(Date.now() - CLOCK);
      sessions.set(command.managerId, {
        liveBackgroundTasks: 0,
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return { cwd: command.cwd };
    },
    async list() {
      return [...sessions.values()];
    },
  });
  const base = createMemoryStores();
  for (const job of options.jobs ?? [jobOf('mgr-1')]) await base.jobs.putJob(job);
  let broken = options.broken ?? false;
  const stores: Stores = {
    ...base,
    jobs: {
      ...base.jobs,
      putJob: async (job) => {
        if (broken) throw new Error('台帳に書けない（試験用）');
        await base.jobs.putJob(job);
      },
    },
  };
  const entries = options.entries ?? [entryOf('runner-a')];
  const registry = fakeRunnerRegistry({
    async list() {
      return [client];
    },
    async get(runnerId) {
      return runnerId === 'runner-a' ? client : null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
    async register() {
      /* この検証では使わない。 */
    },
    async unregister() {
      /* この検証では使わない。 */
    },
    vacate() {
      /* この検証では使わない。 */
    },
    entries() {
      return entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {
      /* この検証では使わない。 */
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
  });
  const inbox: InboxEvent[] = [];
  let postThrows = false;
  const pool = createManagerPool({
    stores,
    post: (event) => {
      if (postThrows && event.type === 'manager_message' && PROLONGED.test(event.text)) {
        throw new Error('受信箱へ積めない（試験用）');
      }
      inbox.push(event);
    },
    runners: registry,
    now: () => Date.now(),
  });
  return {
    pool,
    stores,
    inbox,
    resumeTimes,
    sessions,
    setBroken: (value) => {
      broken = value;
    },
    setPostThrows: (value) => {
      postThrows = value;
    },
  };
}

function noticeTexts(inbox: readonly InboxEvent[]): string[] {
  return inbox.flatMap((event) => (event.type === 'manager_message' ? [event.text] : []));
}

function prolongedNotices(env: Env): string[] {
  return noticeTexts(env.inbox).filter((text) => PROLONGED.test(text));
}

function resolvedNotices(env: Env): string[] {
  return noticeTexts(env.inbox).filter((text) => RESOLVED.test(text));
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.map((entry) => (entry.type === 'exchange' ? entry.text : ''));
}

afterEach(() => {
  vi.useRealTimers();
  setStderrSinkForTesting(null);
});

describe('貸し出しの関門の断りが長引いたとき、受信箱へ1回だけ知らせる', () => {
  it('persist-failed: 閾値の手前では 0 通で、閾値を超えるとちょうど 1 通（日誌にも 1 行）', async () => {
    const env = await build({ broken: true });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS - MINUTE);
    expect(prolongedNotices(env)).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const notices = prolongedNotices(env);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('mgr-1');
    expect(notices[0]).toContain('persist-failed');
    expect(notices[0]).toContain('新しく起こし直さないこと');
    expect(env.resumeTimes).toEqual([]);

    const texts = (await exchangeTexts(env.stores)).filter((text) => PROLONGED.test(text));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('[mgr-1]');
    await env.pool.stop();
  });

  it('held（持ち主が更新し続ける貸し出し）: 閾値の手前では 0 通で、閾値を超えるとちょうど 1 通', async () => {
    const env = await build({ jobs: [jobOf('mgr-1', { lease: heldLease(3 * 60 * MINUTE) })] });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS - MINUTE);
    expect(prolongedNotices(env)).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const notices = prolongedNotices(env);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('mgr-1');
    expect(notices[0]).toContain('held');
    expect(notices[0]).toContain('新しく起こし直さないこと');
    expect(env.resumeTimes).toEqual([]);
    await env.pool.stop();
  });

  it('その後に 10 周以上進めても 1 通のまま。restore・send の契機でも増えない', async () => {
    const env = await build({ broken: true });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS + MINUTE);
    expect(prolongedNotices(env)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(11 * 30_000);
    expect(prolongedNotices(env)).toHaveLength(1);

    await env.pool.restore();
    await env.pool.send('mgr-1', '続きをお願いします');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(prolongedNotices(env)).toHaveLength(1);
    expect((await exchangeTexts(env.stores)).filter((text) => PROLONGED.test(text))).toHaveLength(
      1,
    );
    await env.pool.stop();
  });

  it('失敗が止まって引き取れると「解けた」が 1 通出て、以後は出ない。再び断られたら新しい episode として数え直す', async () => {
    const env = await build({ broken: true });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS + MINUTE);
    expect(prolongedNotices(env)).toHaveLength(1);
    expect(resolvedNotices(env)).toEqual([]);

    env.setBroken(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(env.resumeTimes).toHaveLength(1);
    expect(resolvedNotices(env)).toHaveLength(1);
    expect(resolvedNotices(env)[0]).toContain('mgr-1');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(resolvedNotices(env)).toHaveLength(1);
    expect(prolongedNotices(env)).toHaveLength(1);

    // 器が入れ替わってセッションが消え、同じ委譲がまた断られる: 前の episode の since を引きずらない。
    env.sessions.clear();
    env.setBroken(true);
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS - MINUTE);
    expect(prolongedNotices(env)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(prolongedNotices(env)).toHaveLength(2);
    await env.pool.stop();
  });

  it('held が自然に解けた場合も、長引きを知らせていれば「解けた」が 1 通出る', async () => {
    const ttlMs = 20 * MINUTE;
    const env = await build({ jobs: [jobOf('mgr-1', { lease: heldLease(ttlMs) })] });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS + MINUTE);
    expect(prolongedNotices(env)).toHaveLength(1);
    expect(env.resumeTimes).toEqual([]);

    await vi.advanceTimersByTimeAsync(ttlMs + LEASE_MARGIN_MS);
    expect(env.resumeTimes).toHaveLength(1);
    expect(resolvedNotices(env)).toHaveLength(1);
    expect(prolongedNotices(env)).toHaveLength(1);
    await env.pool.stop();
  });

  it('短い held（約 90 秒で解ける）では、長引きも「解けた」も出ない', async () => {
    const env = await build({
      jobs: [
        jobOf('mgr-1', {
          lease: {
            runnerId: 'runner-a',
            instanceId: 'boot-1',
            fence: 4,
            grantedAt: new Date(CLOCK - 2_000).toISOString(),
            seenAt: new Date(CLOCK - 1_000).toISOString(),
            ttlMs: 10 * MINUTE,
          },
        }),
      ],
      entries: [
        entryOf('runner-a', {
          instanceId: 'boot-2',
          instanceSince: new Date(CLOCK).toISOString(),
        }),
      ],
    });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 40_000);
    expect(env.resumeTimes).toHaveLength(1);
    expect(prolongedNotices(env)).toEqual([]);
    expect(resolvedNotices(env)).toEqual([]);
    await env.pool.stop();
  });

  it('ambiguous（同名 runner の併存）は数えず、既存の即時通知に長引き通知を重ねない', async () => {
    const env = await build({
      jobs: [
        jobOf('mgr-1', {
          lease: {
            runnerId: 'runner-a',
            instanceId: 'boot-1',
            fence: 4,
            grantedAt: new Date(CLOCK - 2_000).toISOString(),
            seenAt: new Date(CLOCK - 1_000).toISOString(),
            ttlMs: 1_000,
          },
        }),
      ],
      entries: [entryOf('runner-a'), entryOf('runner-a', { label: 'runner-a-dup' })],
    });

    // 併存は時間で解けず、梯子も回らない。閾値を超えたあとの契機（send）でも関門に断られる回を作る。
    await env.pool.reattachRunner('runner-a');
    await env.pool.restore();
    await vi.advanceTimersByTimeAsync(PROLONGED_MS + 10 * MINUTE);
    await env.pool.send('mgr-1', '続きをお願いします');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(env.resumeTimes).toEqual([]);
    expect(prolongedNotices(env)).toEqual([]);
    expect(resolvedNotices(env)).toEqual([]);
    // 既存の併存の知らせ（1 通）は変わらない。
    expect(noticeTexts(env.inbox)).toHaveLength(1);
    await env.pool.stop();
  });

  it('held から persist-failed に変わっても since を引き継ぎ、知らせは 1 回のまま（文面は最新の kind）', async () => {
    // 5 分 30 秒で期限が切れて held ではなくなり、以後は台帳に書けず persist-failed になる。
    const env = await build({
      jobs: [jobOf('mgr-1', { lease: heldLease(5 * MINUTE) })],
      broken: true,
    });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS - MINUTE);
    expect(prolongedNotices(env)).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const notices = prolongedNotices(env);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('persist-failed');
    expect(notices[0]).not.toContain('held');

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(prolongedNotices(env)).toHaveLength(1);
    await env.pool.stop();
  });

  it('知らせの書き込みが投げても、関門の結果（断る・梯子で挑み直す・通ったら引き取る）は変わらない', async () => {
    const env = await build({ broken: true });
    const lines: string[] = [];
    setStderrSinkForTesting((line) => lines.push(line));
    env.setPostThrows(true);

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(PROLONGED_MS + 5 * MINUTE);

    expect(env.resumeTimes).toEqual([]);
    expect((await env.stores.jobs.getJob('mgr-1'))?.status).toBe('running');
    expect(prolongedNotices(env)).toEqual([]);
    expect(
      [...lines, ...recentDroppedTraces()].some((line) => line.includes('貸し出しの関門')),
    ).toBe(true);

    env.setPostThrows(false);
    env.setBroken(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(env.resumeTimes).toHaveLength(1);
    expect((await env.stores.jobs.getJob('mgr-1'))?.status).toBe('running');
    await env.pool.stop();
  });
});
