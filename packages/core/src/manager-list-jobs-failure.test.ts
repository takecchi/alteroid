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
import type { InboxEvent, Job, JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **`listJobs()` が投げた回を「委譲が無い」に倒さず、跡を残す**（#2359 の4。先例は
 * #2342 の `manager_stop` の3状態）。
 *
 * `manager.ts` の4か所が `listJobs().catch(() => [])`（または `retry` を立てるだけの
 * `.catch`）だった。読めなかったことが、読めて1本も無かったことと区別できず、日誌にも
 * 残らなかった。ここでは各箇所について、
 *
 * 1. 読めなかった回は「無い」とみなして進まない（握手・通知・取り直しをしない）
 * 2. 読めなかったことが日誌の `decision` に残る
 * 3. 読めた回は今までどおり（対照）
 *
 * を固定する。偽のストアは `listJobs()` だけを途中から壊せる。
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
  /** 名簿の読み（`get`）を投げさせる（#2376）。`undefined` で直す。 */
  breakGet: (reason: string | undefined) => void;
} {
  const clients = new Map<string, RunnerClient>();
  const entries: RunnerEntry[] = [];
  let getFailure: string | undefined;
  const registry: RunnerRegistry = {
    async list() {
      return [...clients.values()];
    },
    async get(runnerId) {
      if (getFailure !== undefined) throw new Error(getFailure);
      return clients.get(runnerId) ?? null;
    },
    async select() {
      throw new Error('この試験では使わない');
    },
    async register() {},
    async unregister() {},
    vacate(runnerId) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId) entry.state = 'vacating';
      }
    },
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
    entries,
    addClient: (client) => clients.set(client.runnerId, client),
    breakGet: (reason) => {
      getFailure = reason;
    },
  };
}

function fakeRunner(runnerId: string): {
  client: RunnerClient;
  resumes: RunnerResumeCommand[];
  stops: string[];
  hold: (managerId: string) => void;
} {
  const resumes: RunnerResumeCommand[] = [];
  const stops: string[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect() {},
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      resumes.push(command);
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      stops.push(managerId);
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
  // 台帳で走っている委譲を、この runner は実際に持っている（握手の相手が居る）。
  const hold = (managerId: string) =>
    sessions.set(managerId, {
      managerId,
      status: 'running',
      cwd: '/work/project',
      request: '依頼',
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  return { client, resumes, stops, hold };
}

function jobWith(id: string, runnerId: string): Job {
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
    lastReport: '途中まで進めた',
    runnerId,
  };
}

/** `listJobs()` だけを途中から壊せる台帳。 */
function harness() {
  const base = createMemoryStores();
  let failure: string | undefined;
  const stores: ReturnType<typeof createMemoryStores> = {
    ...base,
    jobs: {
      ...base.jobs,
      listJobs: async () => {
        if (failure !== undefined) throw new Error(failure);
        return base.jobs.listJobs();
      },
    },
  };
  const fake = createFakeRegistry();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: fake.registry,
  });
  return {
    stores,
    base,
    fake,
    pool,
    inbox,
    breakListJobs: (reason: string) => {
      failure = reason;
    },
    healListJobs: () => {
      failure = undefined;
    },
    journal: async (): Promise<JournalEntry[]> => base.journal.list({ limit: 100 }),
  };
}

function decisionsOf(entries: readonly JournalEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.type === 'decision' ? [`${entry.decision}\n${entry.grounds}`] : [],
  );
}

function reportsOf(inbox: readonly InboxEvent[]) {
  return inbox.filter(
    (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
      event.type === 'manager_message',
  );
}

describe('vacate の握手（manager.ts の vacate）', () => {
  async function setupVacate() {
    const h = harness();
    await h.base.jobs.putJob(jobWith('mgr-a', 'runner-a'));
    h.fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runner = fakeRunner('runner-a');
    runner.hold('mgr-a');
    h.fake.addClient(runner.client);
    return { h, runner };
  }

  it('一覧が読めた回は、載っている委譲へ握手する（対照）', async () => {
    const { h, runner } = await setupVacate();
    const result = await h.pool.vacate('runner-a');
    expect(runner.stops).toEqual(['mgr-a']);
    expect(decisionsOf(await h.journal()).join('\n')).not.toContain('一覧を読めなかった');
    // 対照（#2376）: 握手を飛ばしていないので、戻り値に欄が無い（キーそのものが無い）。
    expect(result).toStrictEqual({});
    await h.pool.stop();
  });

  it('runner が名簿に居ない回は、握手する相手が無いだけで、飛ばしたとは言わない（対照。#2376）', async () => {
    const h = harness();
    await h.base.jobs.putJob(jobWith('mgr-a', 'runner-a'));
    h.fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    // runner-a のクライアントは名簿に足さない（`get` は読めて `null`）。

    const result = await h.pool.vacate('runner-a');

    expect(result).toStrictEqual({});
    expect(decisionsOf(await h.journal()).join('\n')).not.toContain('名簿を読めなかった');
    await h.pool.stop();
  });

  it('名簿が読めなかった回は、居ないとみなさず握手を飛ばし、日誌と戻り値に残す（#2376）', async () => {
    const { h, runner } = await setupVacate();
    h.fake.breakGet('名簿が応えない');

    const result = await h.pool.vacate('runner-a');

    // 握手していない（居ないと確かめたのではない）。貸し出しにも触っていない。
    expect(runner.stops).toEqual([]);
    const text = decisionsOf(await h.journal()).join('\n');
    expect(text).toContain('runnerId=runner-a の vacate で、runner の名簿を読めなかった');
    expect(text).toContain('握手を飛ばした');
    expect(text).toContain('名簿が応えない');
    expect(result.handshakeSkipped?.reason).toBe('runner_unreadable');
    expect(result.handshakeSkipped?.retry).toBe(true);
    expect(result.handshakeSkipped?.message).toContain('名簿を読めなかった');

    // 呼び直せば握手をやり直す（飛ばしたのは握手だけで、名簿の読みが直れば進む）。
    h.fake.breakGet(undefined);
    const again = await h.pool.vacate('runner-a');
    expect(runner.stops).toEqual(['mgr-a']);
    expect(again).toStrictEqual({});
    await h.pool.stop();
  });

  it('一覧が読めなかった回は、委譲が無いとみなさず握手を飛ばし、飛ばしたことを日誌に残す', async () => {
    const { h, runner } = await setupVacate();
    h.breakListJobs('ストアが応えない');

    const result = await h.pool.vacate('runner-a');

    // 応答で言う（#2376）: 握手を飛ばした（一覧を読めなかった）。呼び直せばやり直す。
    expect(result.handshakeSkipped?.reason).toBe('jobs_unreadable');
    expect(result.handshakeSkipped?.retry).toBe(true);
    expect(result.handshakeSkipped?.message).toContain('一覧を読めなかった');

    // 握手していない（委譲が無いと確かめたのではない）。貸し出しにも触っていない。
    expect(runner.stops).toEqual([]);
    const text = decisionsOf(await h.journal()).join('\n');
    expect(text).toContain('台帳の委譲の一覧を読めなかった');
    expect(text).toContain('runnerId=runner-a の vacate で');
    expect(text).toContain('握手を飛ばした');
    expect(text).toContain('ストアが応えない');
    await h.pool.stop();
  });
});

describe('併存の通知（manager.ts の #reattach）', () => {
  async function setupAmbiguous() {
    const h = harness();
    await h.base.jobs.putJob(jobWith('mgr-a', 'runner-a'));
    h.fake.entries.push(entryOf('http://one', 'connected', 'runner-a'));
    h.fake.entries.push(entryOf('http://two', 'connected', 'runner-a'));
    const runner = fakeRunner('runner-a');
    h.fake.addClient(runner.client);
    return { h, runner };
  }

  it('一覧が読めた回は、併存を受信箱へ知らせる（対照）', async () => {
    const { h } = await setupAmbiguous();
    await h.pool.reattachRunner('runner-a');
    expect(reportsOf(h.inbox)).toHaveLength(1);
    expect(reportsOf(h.inbox)[0]?.managerId).toBe('mgr-a');
    expect(decisionsOf(await h.journal()).join('\n')).not.toContain('一覧を読めなかった');
    await h.pool.stop();
  });

  it('一覧が読めなかった回は、通知を見送って跡を残し、通知済みにもしない（次に読めたら言う）', async () => {
    const { h } = await setupAmbiguous();
    h.breakListJobs('ストアが応えない');

    await h.pool.reattachRunner('runner-a');

    expect(reportsOf(h.inbox)).toEqual([]);
    const text = decisionsOf(await h.journal()).join('\n');
    expect(text).toContain('台帳の委譲の一覧を読めなかった');
    expect(text).toContain('併存の通知を見送った');
    expect(text).toContain('ストアが応えない');

    // 見送る設計は保つ: 通知済みにしていないので、次に読めた回には届く。
    h.healListJobs();
    await h.pool.reattachRunner('runner-a');
    expect(reportsOf(h.inbox)).toHaveLength(1);
    expect(reportsOf(h.inbox)[0]?.managerId).toBe('mgr-a');
    await h.pool.stop();
  });

  it('併存が解けた回に一覧が読めなかったら、「解けた」を言わず跡を残す（次に読めたら言う）', async () => {
    const { h, runner } = await setupAmbiguous();
    await h.pool.reattachRunner('runner-a');
    expect(reportsOf(h.inbox)).toHaveLength(1);

    // 併存が解ける（2台目が居なくなる）が、台帳は読めない。
    h.fake.entries.pop();
    h.breakListJobs('ストアが応えない');
    await h.pool.reattachRunner('runner-a');

    expect(reportsOf(h.inbox)).toHaveLength(1);
    const text = decisionsOf(await h.journal()).join('\n');
    expect(text).toContain('併存が解けた通知を見送った');
    // 取り直しの本体も、一覧が読めないので進んでいない（委譲が無いとは読んでいない）。
    expect(runner.resumes).toEqual([]);

    h.healListJobs();
    await h.pool.reattachRunner('runner-a');
    // 取り直しが進んだ分の知らせも出るので、「解けた」だけを数える。
    expect(reportsOf(h.inbox).filter((r) => r.text.includes('併存は解けました'))).toHaveLength(1);
    await h.pool.stop();
  });
});

describe('取り直しの台帳の読み（manager.ts の #reattach）', () => {
  it('一覧が読めなかった回は、何も起こさず、読めなかったことを日誌に残す', async () => {
    const h = harness();
    await h.base.jobs.putJob(jobWith('mgr-a', 'runner-a'));
    h.fake.entries.push(entryOf('http://one', 'connected', 'runner-a'));
    const runner = fakeRunner('runner-a');
    h.fake.addClient(runner.client);
    h.breakListJobs('ストアが応えない');

    await h.pool.reattachRunner('runner-a');

    expect(runner.resumes).toEqual([]);
    const text = decisionsOf(await h.journal()).join('\n');
    expect(text).toContain('台帳の委譲の一覧を読めなかった');
    expect(text).toContain('取り直しを進めなかった');
    expect(text).toContain('ストアが応えない');
    await h.pool.stop();
  });
});
