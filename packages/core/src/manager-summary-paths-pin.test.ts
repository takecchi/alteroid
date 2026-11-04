import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerSummary } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool` が `summaryOf` を呼ぶ3つの道（起こした直後・list/get・起動時の引き取り）の出力を固定する。
// 3つの呼び出しを1つにまとめる整理の前後で、引数の取り違えが起きていないことを縛るための試験。
// 取り違えが見えるよう、鍵の世代（抱えている世代と現役の世代）・runnerListedAt・live を既定値以外にする。

const CLOCK = new Date('2026-10-01T00:00:00.000Z').getTime();
const OBSERVED_AT = '2026-10-01T00:00:10.000Z';
const WORKSPACE = '/work/project';
const OPENED_CWD = '/work/opened';

// 揺れる値（発行された id）は固定の名前へ置き換える。時刻は注入した時計で固定済み。
function normalized<T>(value: T, ids: Readonly<Record<string, string>>): T {
  let text = JSON.stringify(value);
  for (const [from, to] of Object.entries(ids)) text = text.replaceAll(from, to);
  return JSON.parse(text) as T;
}

function fakeRunner(hooks: {
  onStart?: (managerId: string) => void;
  onResume?: () => void;
  alive?: Job[];
}) {
  const resumed: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: WORKSPACE,
    workspacePathKnown: true,
    async connect() {
      /* イベントは流さない */
    },
    async start(command): Promise<{ cwd: string }> {
      hooks.onStart?.(command.managerId);
      return { cwd: OPENED_CWD };
    },
    async resume(command): Promise<{ cwd: string }> {
      hooks.onResume?.();
      resumed.push({
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
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [
        ...(hooks.alive ?? []).map((job): RunnerManagerState => ({
          liveBackgroundTasks: 0,
          managerId: job.id,
          status: 'running',
          cwd: job.cwd ?? WORKSPACE,
          request: job.request ?? '',
          waiting: [],
          ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
        })),
        ...resumed,
      ];
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return runner;
}

// 名簿の観測（runner の一覧に載っている委譲 id と観測時刻）を `entries()` へ直接差し込む。
function withListedSessions(registry: RunnerRegistry, listed: () => readonly string[]) {
  const wrapped: RunnerRegistry = {
    list: () => registry.list(),
    get: (id) => registry.get(id),
    select: (input) => registry.select(input),
    register: (source) => registry.register(source),
    unregister: (label) => registry.unregister(label),
    vacate: (id) => registry.vacate(id),
    noteManagerFailed: (id) => registry.noteManagerFailed(id),
    subscribe: (onOpen) => registry.subscribe(onOpen),
    stop: () => registry.stop(),
    entries: () =>
      registry.entries().map((entry) => ({
        ...entry,
        sessions: listed(),
        sessionsObservedAt: OBSERVED_AT,
      })),
  };
  return wrapped;
}

describe('委譲の要約を組む3つの道の出力を固定する', () => {
  it('道1と道2: start() の戻り値と、その後の list() / get() の要約', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 1 };
    const listed: string[] = [];
    let startedId = '';
    const runner = fakeRunner({
      onStart: (managerId) => {
        startedId = managerId;
        // 起こした後に鍵が回った: 抱えている世代（1）と現役の世代（2）を食い違わせる。
        current = { tokenId: 'tok-b', generation: 2 };
        listed.push(managerId);
      },
    });
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: withListedSessions(registry, () => listed),
      profile: createProfileService({ stores, runners: registry }),
      tokenIdentity: () => current,
      now: () => CLOCK,
    });
    await pool.restore();

    const started = await pool.start({ request: '調べておいて', cwd: WORKSPACE });
    const ids = { [startedId]: 'mgr-started' };
    const normalizedStarted = normalized(started, ids);
    expect(normalizedStarted.tokenGeneration).toBe(1);
    expect(normalizedStarted.activeTokenGeneration).toBe(2);
    expect(normalizedStarted.runnerListedAt).toBe(OBSERVED_AT);
    expect(normalizedStarted.live).toBe(true);
    expect(normalizedStarted.cwdConfirmed).toBe(true);
    expect(normalizedStarted.requestedCwd).toBe(WORKSPACE);
    expect(normalizedStarted).toMatchSnapshot('start() の戻り値');

    const fromList = (await pool.list()).find((m) => m.managerId === startedId);
    const fromGet = await pool.get?.(startedId);
    expect(fromList).toBeDefined();
    expect(fromGet).toBeDefined();
    const listSummary = normalized(fromList as ManagerSummary, ids);
    expect(listSummary.tokenGeneration).toBe(1);
    expect(listSummary.activeTokenGeneration).toBe(2);
    expect(listSummary.runnerListedAt).toBe(OBSERVED_AT);
    expect(listSummary).toMatchSnapshot('list() の要素');
    expect(normalized(fromGet as ManagerSummary, ids)).toEqual(listSummary);

    await pool.stop();
    await registry.stop();
  });

  it('道3: restore() の戻り値（生きていたセッションの引き取りと resume の受理）', async () => {
    const stores = createMemoryStores();
    const base = {
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      status: 'running',
      cwd: WORKSPACE,
      runnerId: 'runner-primary',
    } as const;
    const living: Job = {
      ...base,
      id: 'mgr-living',
      managerId: 'mgr-living',
      summary: '生きている',
      request: '生きている依頼',
      sessionId: 'sess-living',
    };
    const resumable: Job = {
      ...base,
      id: 'mgr-resumable',
      managerId: 'mgr-resumable',
      summary: '戻す',
      request: '戻す依頼',
      sessionId: 'sess-resumable',
    };
    await stores.jobs.putJob(living);
    await stores.jobs.putJob(resumable);
    let current = { tokenId: 'tok-b', generation: 2 };
    // resume の受理の後（台帳へ書き戻す間）に鍵が回った: 抱えている世代（2）と現役の世代（3）を食い違わせる。
    let resumeCalled = false;
    const putJob = stores.jobs.putJob.bind(stores.jobs);
    stores.jobs.putJob = async (job) => {
      await putJob(job);
      if (resumeCalled && job.id === 'mgr-resumable') {
        current = { tokenId: 'tok-c', generation: 3 };
      }
    };
    const runner = fakeRunner({
      alive: [living],
      onResume: () => {
        resumeCalled = true;
      },
    });
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      // 名簿は両方を「一覧に載っている」と言うが、引き取りの要約は runnerListedAt を載せない。
      runners: withListedSessions(registry, () => ['mgr-living', 'mgr-resumable']),
      profile: createProfileService({ stores, runners: registry }),
      tokenIdentity: () => current,
      now: () => CLOCK,
    });

    const restored = await pool.restore();
    const byId = [...restored].sort((a, b) => a.managerId.localeCompare(b.managerId));
    expect(byId.map((m) => m.managerId)).toEqual(['mgr-living', 'mgr-resumable']);
    const [takenOver, resumedSummary] = byId;
    // 引き取っただけでは抱えている世代を書かない（欄が立たず、世代が測れない理由が立つ）。
    expect(takenOver?.tokenGeneration).toBeUndefined();
    expect(takenOver?.activeTokenGeneration).toBeUndefined();
    // resume の受理では覚える（2）。そのあとに現役が回って 3。
    expect(resumedSummary?.tokenGeneration).toBe(2);
    expect(resumedSummary?.activeTokenGeneration).toBe(3);
    for (const summary of byId) {
      expect(summary.runnerListedAt).toBeUndefined();
      expect(summary.live).toBe(true);
    }
    expect(byId).toMatchSnapshot('restore() の戻り値');

    await pool.stop();
    await registry.stop();
  });
});
