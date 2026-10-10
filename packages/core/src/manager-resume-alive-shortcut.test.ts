import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPoolOptions } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerResumeCommand,
  type RunnerResumeResult,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

const JOB: Job = {
  id: 'mgr-alive',
  managerId: 'mgr-alive',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T01:00:00.000Z',
  status: 'done',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function shortcutRunner(
  report: 'true' | 'false' | 'absent' = 'true',
  live = true,
  session: {
    tokenFingerprint?: string;
    liveBackgroundTasks?: number;
    waiting?: RunnerManagerState['waiting'];
  } = {},
) {
  const alive: RunnerManagerState[] = live
    ? [
        {
          managerId: 'mgr-alive',
          status: 'done',
          cwd: '/work/project',
          request: '調べておいて',
          waiting: session.waiting ?? [],
          sessionId: 'sess-1',
          ...(session.tokenFingerprint === undefined
            ? {}
            : { tokenFingerprint: session.tokenFingerprint }),
          ...(session.liveBackgroundTasks === undefined
            ? {}
            : { liveBackgroundTasks: session.liveBackgroundTasks }),
        },
      ]
    : [];
  const stops: string[] = [];
  let listCalls = 0;
  const pushedToLiveProcess: string[] = [];
  const spawned: RunnerResumeCommand[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {
      /* この検証では使わない */
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<RunnerResumeResult> {
      if (alive.some((state) => state.managerId === command.managerId)) {
        if (command.message !== undefined) pushedToLiveProcess.push(command.message);
        return {
          cwd: '/work/project',
          ...(report === 'absent' ? {} : { reusedLiveSession: true }),
        };
      }
      spawned.push(command);
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return report === 'absent' ? {} : { reusedLiveSession: false };
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      stops.push(managerId);
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async ping() {
      /* 生存確認（名簿が10秒ごとに叩く）に応える */
    },
    async list() {
      listCalls += 1;
      return alive.map((state) => ({ ...state }));
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
  return {
    runner,
    pushedToLiveProcess,
    spawned,
    stops,
    get listCalls() {
      return listCalls;
    },
    mutateSession(patch: Partial<RunnerManagerState>) {
      const state = alive.find((entry) => entry.managerId === 'mgr-alive');
      if (state !== undefined) Object.assign(state, patch);
    },
  };
}

async function sendAfterRestart(
  report: 'true' | 'false' | 'absent',
  live: boolean,
  options: {
    session?: Parameters<typeof shortcutRunner>[2];
    activeFingerprint?: string;
    tokenAvailability?: ManagerPoolOptions['tokenAvailability'];
    observe?: boolean;
    afterObserve?: (fake: ReturnType<typeof shortcutRunner>) => void;
    beforeSend?: (fake: ReturnType<typeof shortcutRunner>) => void;
  } = {},
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = shortcutRunner(report, live, options.session);
  const registry = createRunnerRegistry([]);
  await registry.register({ label: 'http://runner:4518', open: async () => fake.runner });
  if (options.observe !== false) await vi.advanceTimersByTimeAsync(10_000);
  options.afterObserve?.(fake);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({
      tokenId: 'tok-b',
      generation: 60,
      ...(options.activeFingerprint === undefined
        ? {}
        : { fingerprint: options.activeFingerprint }),
    }),
    ...(options.tokenAvailability === undefined
      ? {}
      : { tokenAvailability: options.tokenAvailability }),
  });
  await pool.restore();
  const before = (await pool.list()).find((s) => s.managerId === 'mgr-alive');
  expect(before?.tokenGeneration).toBeUndefined();
  options.beforeSend?.(fake);
  const listsBeforeSend = fake.listCalls;
  const result = await pool.send('mgr-alive', '続きを');
  const listsDuringSend = fake.listCalls - listsBeforeSend;
  const after = (await pool.list()).find((s) => s.managerId === 'mgr-alive');
  return { pool, fake, result, after, listsDuringSend, registry };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resume が生きた旧プロセスへ短絡したとき、世代を「一致」にしない（#2877）', () => {
  it('⚠️ 欄あり true: デーモン再起動後の done へ send して旧プロセスへ流れた回は、世代を現役と名乗らず、detail で言う', async () => {
    const s = await sendAfterRestart('true', true);

    expect(s.result.outcome).toBe('delivered');
    expect(s.fake.spawned).toHaveLength(0);
    expect(s.fake.pushedToLiveProcess).toEqual(['続きを']);
    // 旧プロセスの鍵が現役かどうかは確かめていないので、「一致」と名乗らない。
    expect(s.after?.tokenGeneration).toBeUndefined();
    expect(s.result.detail).toContain('生きた旧プロセスへ流した');
    expect(s.result.detail).toContain('確かめていない');
    await s.pool.stop();
  });

  it('欄あり false: 新しい SDK を起こした回は、従来どおり世代を現役へ書く', async () => {
    const s = await sendAfterRestart('false', false);

    expect(s.fake.spawned).toHaveLength(1);
    expect(s.after?.tokenGeneration).toBe(60);
    expect(s.result.detail).not.toContain('旧プロセス');
    await s.pool.stop();
  });

  it('欄なし（古い runner）: 短絡を見分けられないので、従来どおり世代を書く（版が混ざる窓の限界）', async () => {
    const s = await sendAfterRestart('absent', true);

    expect(s.fake.pushedToLiveProcess).toEqual(['続きを']);
    // 古い runner の間は偽の一致を防げない。これは限界であって、期待ではない。
    expect(s.after?.tokenGeneration).toBe(60);
    expect(s.result.detail).not.toContain('旧プロセス');
    await s.pool.stop();
  });
});

describe('再起動後の done を、起動時に掴んだ鍵の指紋で見る（#2877 PR2）', () => {
  const OLD_FP = 'aaaaaaaaaaaa';
  const NEW_FP = 'bbbbbbbbbbbb';

  it('⭐ 指紋が食い違い・背景処理 0 本・確認待ち無し: 畳んで新しい鍵で起こし直し、世代を書く', async () => {
    const s = await sendAfterRestart('false', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 0 },
      activeFingerprint: NEW_FP,
    });

    expect(s.result.outcome).toBe('delivered');
    expect(s.fake.pushedToLiveProcess).toHaveLength(0);
    expect(s.fake.stops).toEqual(['mgr-alive']);
    expect(s.fake.spawned).toHaveLength(1);
    expect(s.fake.spawned[0]?.sessionId).toBe('sess-1');
    expect(s.fake.spawned[0]?.message).toBe('続きを');
    expect(s.after?.tokenGeneration).toBe(60);
    await s.pool.stop();
  });

  it('⚠️ 指紋が食い違い、背景処理が残っていれば、畳まず・流さず断る（detail に指紋以外の鍵の情報は出ない）', async () => {
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 2 },
      activeFingerprint: NEW_FP,
    });

    expect(s.result.outcome).toBe('declined');
    expect(s.result.detail).toContain('2 本');
    expect(s.result.detail).toContain(OLD_FP);
    expect(s.result.detail).toContain(NEW_FP);
    expect(s.result.detail).toContain('manager_stop');
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.spawned).toHaveLength(0);
    expect(s.fake.pushedToLiveProcess).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 指紋で判定する回（attached=false）は、注入口が ready を返しても背景処理が残っていれば断る（#4441）', async () => {
    const asked: string[] = [];
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 2 },
      activeFingerprint: NEW_FP,
      tokenAvailability: async (tokenId) => {
        asked.push(tokenId);
        return 'ready';
      },
    });

    expect(s.result.outcome).toBe('declined');
    expect(asked).toHaveLength(0);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.pushedToLiveProcess).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 指紋が食い違い、背景処理の本数が分からない（欄の無い runner）なら、「分からない」と言って断る', async () => {
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP },
      activeFingerprint: NEW_FP,
    });

    expect(s.result.outcome).toBe('declined');
    expect(s.result.detail).toContain('分からない');
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.pushedToLiveProcess).toHaveLength(0);
    await s.pool.stop();
  });

  it('⚠️ 指紋が食い違い、確認待ちが残っていれば断る', async () => {
    const s = await sendAfterRestart('true', true, {
      session: {
        tokenFingerprint: OLD_FP,
        liveBackgroundTasks: 0,
        waiting: [
          {
            requestId: 'req-1',
            summary: 'Bash を許可するか',
            kind: 'permission',
            askedAt: '2026-10-05T01:00:00.000Z',
          },
        ],
      },
      activeFingerprint: NEW_FP,
    });

    expect(s.result.outcome).toBe('declined');
    expect(s.result.detail).toContain('確認待ち');
    expect(s.fake.stops).toHaveLength(0);
    await s.pool.stop();
  });

  it('⭐ 観測が食い違いを示したときだけ list を1回取り直す。観測が古く実際は一致していたら畳まない', async () => {
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 0 },
      activeFingerprint: NEW_FP,
      afterObserve: (fake) => fake.mutateSession({ tokenFingerprint: NEW_FP }),
    });

    expect(s.listsDuringSend).toBe(1);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.spawned).toHaveLength(0);
    expect(s.fake.pushedToLiveProcess).toEqual(['続きを']);
    expect(s.after?.tokenGeneration).toBe(60);
    await s.pool.stop();
  });

  it('⚠️ 取り直したらターンが走っていた: 畳まず・流さず断る', async () => {
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 0 },
      activeFingerprint: NEW_FP,
      beforeSend: (fake) => fake.mutateSession({ status: 'running' }),
    });

    expect(s.listsDuringSend).toBe(1);
    expect(s.result.outcome).toBe('declined');
    expect(s.result.detail).toContain('ターンが走っている');
    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.pushedToLiveProcess).toHaveLength(0);
    await s.pool.stop();
  });

  it('普段の経路（食い違いが無い・確かめられない）では list の往復を足さない', async () => {
    const none = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 0 },
      activeFingerprint: NEW_FP,
      observe: false,
    });
    expect(none.listsDuringSend).toBe(0);
    expect(none.fake.pushedToLiveProcess).toEqual(['続きを']);
    expect(none.after?.tokenGeneration).toBeUndefined();
    await none.pool.stop();

    const same = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: NEW_FP, liveBackgroundTasks: 0 },
      activeFingerprint: NEW_FP,
    });
    expect(same.listsDuringSend).toBe(0);
    await same.pool.stop();

    const old = await sendAfterRestart('true', true, { activeFingerprint: NEW_FP });
    expect(old.listsDuringSend).toBe(0);
    await old.pool.stop();
  });

  it('指紋が一致: 旧プロセスの鍵は現役なので流し、世代を書いてよい（「確かめていない」とは言わない）', async () => {
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: NEW_FP, liveBackgroundTasks: 0 },
      activeFingerprint: NEW_FP,
    });

    expect(s.result.outcome).toBe('delivered');
    expect(s.fake.pushedToLiveProcess).toEqual(['続きを']);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.after?.tokenGeneration).toBe(60);
    expect(s.result.detail).not.toContain('確かめていない');
    await s.pool.stop();
  });

  it('版の混在: セッションの指紋が読めない（欄の無い古い runner）なら、断らず流し、世代は書かない', async () => {
    const s = await sendAfterRestart('true', true, { activeFingerprint: NEW_FP });

    expect(s.result.outcome).toBe('delivered');
    expect(s.fake.pushedToLiveProcess).toEqual(['続きを']);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.after?.tokenGeneration).toBeUndefined();
    expect(s.result.detail).toContain('確かめていない');
    await s.pool.stop();
  });

  it('版の混在: 現役の指紋が分からないなら、断らず流し、世代は書かない', async () => {
    const s = await sendAfterRestart('true', true, {
      session: { tokenFingerprint: OLD_FP, liveBackgroundTasks: 0 },
    });

    expect(s.result.outcome).toBe('delivered');
    expect(s.fake.pushedToLiveProcess).toEqual(['続きを']);
    expect(s.fake.stops).toHaveLength(0);
    expect(s.after?.tokenGeneration).toBeUndefined();
    await s.pool.stop();
  });
});
