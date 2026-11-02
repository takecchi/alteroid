import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXCHANGE_KIND_REPLY_PREFIX } from './exchange-kind.js';
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
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 「resume の最中に届く出来事を預ける窓」（移送の窓・同じ runner への復帰の窓）の外から見える振る舞いのうち、
 * 既存の試験が縛っていない所を縛る（窓を `Pool` から別のクラスへ切り出すときの取り違え防止）。
 * 公開の口（`createManagerPool` が返す口）と、runner の出来事を流す試験用の口だけを使い、非公開の欄は読まない。
 */
describe('resume の最中に届く出来事を預ける窓', () => {
  const pools: { stop: () => Promise<void> }[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const pool of pools.splice(0)) await pool.stop();
  });

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
    /** `get` の入口で呼ぶ。返した Promise が解けるまで `get` は返らない。 */
    hooks: { onGet?: (runnerId: string) => Promise<void> | undefined };
  } {
    const clients = new Map<string, RunnerClient>();
    const entries: RunnerEntry[] = [];
    const hooks: { onGet?: (runnerId: string) => Promise<void> | undefined } = {};
    const registry: RunnerRegistry = {
      async list() {
        return [...clients.values()];
      },
      async get(runnerId) {
        await hooks.onGet?.(runnerId);
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
      hooks,
    };
  }

  function fakeRunner(
    runnerId: string,
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
      workspacePath: '/work/project',
      async connect(onEvent) {
        holder.emit = onEvent;
      },
      async start(command): Promise<{ cwd: string }> {
        return { cwd: command.cwd };
      },
      async resume(command): Promise<{ cwd: string; sessionGeneration?: string }> {
        resumes.push(command);
        sessions.set(command.managerId, {
          liveBackgroundTasks: 0,
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        return sessionGeneration === undefined
          ? { cwd: command.cwd }
          : { cwd: command.cwd, sessionGeneration };
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

  /** `resume` を、`release()` まで返さない門にする。入った印（`entered`）も返す。 */
  function gateResume(
    runner: ReturnType<typeof fakeRunner>,
    outcome: 'accept' | 'refuse' = 'accept',
  ): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = runner.client.resume.bind(runner.client);
    runner.client.resume = async (command) => {
      entered();
      await gate;
      if (outcome === 'refuse') throw new RunnerHttpError('unavailable', 503);
      return original(command);
    };
    return { entered: enteredPromise, release };
  }

  function jobWith(id: string, runnerId: string, overrides: Partial<Job> = {}): Job {
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
      runnerId,
      ...overrides,
    };
  }

  const LEASE_OF_A = {
    runnerId: 'runner-a',
    fence: 4,
    grantedAt: '2026-01-01T00:00:00.000Z',
    seenAt: '2026-01-01T00:00:00.000Z',
    ttlMs: 60_000,
  };

  /** 起きていないことを見る前に、残りの非同期の続きを macrotask 2周ぶん流しきる（実時間は使わない）。 */
  async function drain(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  type Stores = ReturnType<typeof createMemoryStores>;

  async function jobOf(stores: Stores, id: string): Promise<Job | undefined> {
    return (await stores.jobs.listJobs()).find((job) => job.id === id);
  }

  async function exchangeTexts(stores: Stores): Promise<string[]> {
    return (await stores.journal.list({ types: ['exchange'] })).map((entry) =>
      entry.type === 'exchange' ? entry.text : '',
    );
  }

  const textsOf = (inbox: unknown[]): string[] =>
    (inbox as { text?: string }[]).map((event) => event.text ?? '');

  // ---------------------------------------------------------------------------------------------
  // 同じ runner-a への復帰の窓（`#reattachOne` の !relocating 側）の舞台。
  // ---------------------------------------------------------------------------------------------
  async function sameRunnerRig(
    options: { generation?: string; outcome?: 'accept' | 'refuse' } = {},
  ) {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-same', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a', options.generation);
    const resume = gateResume(runnerA, options.outcome ?? 'accept');
    fake.addClient(runnerA.client);
    const inbox: unknown[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
    });
    pools.push(pool);
    // 存在しない managerId の abort で connect だけを踏ませる: 出来事を流す口（emit）が得られる経路がこれしか無い。
    await pool.abort('mgr-does-not-exist');
    const reattach = pool.reattachRunner('runner-a');
    await resume.entered;
    return { stores, pool, inbox, runnerA, release: resume.release, reattach };
  }

  // 窓が開いている間（resume の応答の前）に、その場で処理されることを見る。窓が預けるなら、閉じるまで効かない。
  describe('同じ runner への復帰の窓は、report と closed だけを預ける', () => {
    it('窓の間に届いた ask は預けず、その場で待ちへ積んでクローンへ配る', async () => {
      const { stores, inbox, runnerA, release, reattach } = await sameRunnerRig();
      runnerA.emit?.({
        type: 'ask',
        managerId: 'mgr-same',
        requestId: 'ask-in-window',
        kind: 'permission',
        summary: 'Bash の実行許可（窓の間の確認）',
      } as RunnerEvent);
      await vi.waitFor(async () => {
        expect((await jobOf(stores, 'mgr-same'))?.status).toBe('waiting_human');
      });
      expect(textsOf(inbox).filter((text) => text.includes('窓の間の確認')).length).toBe(1);
      release();
      await reattach;
    });

    it('窓の間に届いた session は預けず、その場で台帳の sessionId へ書く', async () => {
      const { stores, runnerA, release, reattach } = await sameRunnerRig();
      runnerA.emit?.({
        type: 'session',
        managerId: 'mgr-same',
        sessionId: 'sess-in-window',
      } as RunnerEvent);
      await vi.waitFor(async () => {
        expect((await jobOf(stores, 'mgr-same'))?.sessionId).toBe('sess-in-window');
      });
      release();
      await reattach;
    });

    it('窓の間に届いた settled（取り下げ）は預けず、その場で日誌へ取り下げを残す', async () => {
      const { stores, runnerA, release, reattach } = await sameRunnerRig();
      runnerA.emit?.({
        type: 'settled',
        managerId: 'mgr-same',
        requestId: 'withdrawn-in-window',
        withdrawn: { reason: 'セッションを畳んだ' },
      } as RunnerEvent);
      await vi.waitFor(async () => {
        const withdrawn = (await stores.journal.list({ types: ['escalation'] })).filter(
          (entry) => entry.type === 'escalation' && entry.approvalId === 'withdrawn-in-window',
        );
        expect(withdrawn.length).toBe(1);
      });
      release();
      await reattach;
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 窓が閉じた後は、同じ担当の出来事を預けない（窓の欄が空になった印）。
  // ---------------------------------------------------------------------------------------------
  describe('窓が閉じた後は、同じ担当の出来事を預けずに処理する', () => {
    it('同じ runner への復帰の窓が閉じた後に届いた report は、その場で台帳へ効く', async () => {
      const { stores, runnerA, release, reattach } = await sameRunnerRig({
        generation: 'gen-new',
      });
      release();
      await reattach;
      runnerA.emit?.({
        type: 'report',
        managerId: 'mgr-same',
        status: 'running',
        text: '窓が閉じた後の報告',
        sessionGeneration: 'gen-new',
      } as RunnerEvent);
      await vi.waitFor(async () => {
        expect((await jobOf(stores, 'mgr-same'))?.lastReport).toBe('窓が閉じた後の報告');
      });
    });

    it('移送の窓が閉じた後に移送先から届いた report は、その場で台帳へ効く', async () => {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-moved', 'runner-a', { lease: LEASE_OF_A }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      const runnerA = fakeRunner('runner-a');
      const runnerB = fakeRunner('runner-b');
      const resume = gateResume(runnerB);
      fake.addClient(runnerA.client);
      fake.addClient(runnerB.client);
      const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
      pools.push(pool);
      await pool.abort('mgr-does-not-exist');
      const reattach = pool.reattachRunner('runner-b');
      await resume.entered;
      resume.release();
      await reattach;
      expect((await jobOf(stores, 'mgr-moved'))?.runnerId).toBe('runner-b');

      runnerB.emit?.({
        type: 'report',
        managerId: 'mgr-moved',
        status: 'running',
        text: '移送が済んだ後の移送先の報告',
      } as RunnerEvent);
      await vi.waitFor(async () => {
        expect((await jobOf(stores, 'mgr-moved'))?.lastReport).toBe('移送が済んだ後の移送先の報告');
      });
    });

    it('先の窓で預けて流し終えた出来事は、次の窓を閉じるときに二度流し直されない', async () => {
      const { stores, runnerA, release, reattach, pool } = await sameRunnerRig();
      // reportId を持たない旧 runner の report は冪等にならないので、二度流されれば二度配られる。
      runnerA.emit?.({
        type: 'report',
        managerId: 'mgr-same',
        status: 'running',
        text: '一つ目の窓で預けた報告',
      } as RunnerEvent);
      await drain();
      release();
      await reattach;
      // 受け取った report は、処理されるたびに日誌へ「[応答]」の行が1本残る（取り直しの知らせは lastReport を引用するので、受信箱では数えない）。
      const processed = async (): Promise<number> =>
        (await exchangeTexts(stores)).filter((text) =>
          text.startsWith(`${EXCHANGE_KIND_REPLY_PREFIX}[mgr-same] 一つ目の窓で預けた報告`),
        ).length;
      await vi.waitFor(async () => {
        expect(await processed()).toBe(1);
      });
      // 器の中のセッションを失わせ、同じ担当で2回目の窓（同じ runner への復帰）を開かせる。
      await runnerA.client.stop('mgr-same');
      await pool.reattachRunner('runner-a');
      expect((await jobOf(stores, 'mgr-same'))?.status).toBe('running');
      await drain();
      expect(await processed()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 流し直しで捨てた出来事の日誌の全文。
  // ---------------------------------------------------------------------------------------------
  describe('窓の間に届いて捨てた出来事の日誌の全文', () => {
    async function relocateRig(outcome: 'accept' | 'refuse') {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-moved', 'runner-a', { lease: LEASE_OF_A }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      const runnerA = fakeRunner('runner-a');
      const runnerB = fakeRunner('runner-b');
      const resume = gateResume(runnerB, outcome);
      fake.addClient(runnerA.client);
      fake.addClient(runnerB.client);
      const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
      pools.push(pool);
      await pool.abort('mgr-does-not-exist');
      const reattach = pool.reattachRunner('runner-b');
      await resume.entered;
      return { stores, runnerA, runnerB, release: resume.release, reattach };
    }

    it('移送が受理された回に捨てた、元の runner の closed と report', async () => {
      const { stores, runnerA, release, reattach } = await relocateRig('accept');
      runnerA.emit?.({
        type: 'closed',
        managerId: 'mgr-moved',
        status: 'lost',
        reason: '元の runner が畳んだ',
      });
      runnerA.emit?.({
        type: 'report',
        managerId: 'mgr-moved',
        status: 'running',
        text: '元の runner の遅れた報告',
      } as RunnerEvent);
      await drain();
      release();
      await reattach;
      await vi.waitFor(async () => {
        expect(
          // 届いた順は出来事の種類ごとの入口の段数で決まるので、並びは問わない。
          (await exchangeTexts(stores))
            .filter((text) => text.includes('移送の最中に届いた古い'))
            .sort(),
        ).toEqual([
          '[判断] [mgr-moved] （移送の最中に届いた古い runner の出来事のため無視。移送先は runner-b、この出来事は runner-a から）' +
            'runner 側の終了イベント（status=lost）を受け取った: 元の runner が畳んだ',
          '[判断] [mgr-moved] （移送の最中に届いた古い runner の出来事のため無視。移送先は runner-b、この出来事は runner-a から）' +
            '移送の最中に届いた古い runner の report を無視した\n\n捨てた報告の本文: 元の runner の遅れた報告',
        ]);
      });
    });

    it('移送が受理されなかった回に捨てた、移送先自身の closed と report', async () => {
      const { stores, runnerB, release, reattach } = await relocateRig('refuse');
      runnerB.emit?.({
        type: 'closed',
        managerId: 'mgr-moved',
        status: 'failed',
        reason: '移送先が落ちた',
      });
      runnerB.emit?.({
        type: 'report',
        managerId: 'mgr-moved',
        status: 'running',
        text: '引き取られなかった移送先の報告',
      } as RunnerEvent);
      await drain();
      release();
      await reattach;
      await vi.waitFor(async () => {
        expect(
          // 届いた順は出来事の種類ごとの入口の段数で決まるので、並びは問わない。
          (await exchangeTexts(stores))
            .filter((text) => text.includes('移送の最中に届いた古い'))
            .sort(),
        ).toEqual([
          '[判断] [mgr-moved] （移送の最中に届いた古い runner の出来事のため無視。移送先は runner-b、この出来事は runner-b から。移送は受理されなかった）' +
            'runner 側の終了イベント（status=failed）を受け取った: 移送先が落ちた',
          '[判断] [mgr-moved] （移送の最中に届いた古い runner の出来事のため無視。移送先は runner-b、この出来事は runner-b から。移送は受理されなかった）' +
            '移送の最中に届いた古い runner の report を無視した\n\n捨てた報告の本文: 引き取られなかった移送先の報告',
        ]);
      });
    });

    const withdrawnEscalations = async (stores: Stores, requestId: string): Promise<number> =>
      (await stores.journal.list({ types: ['escalation'] })).filter(
        (entry) => entry.type === 'escalation' && entry.approvalId === requestId,
      ).length;

    it('移送が受理された回、窓の間に届いた元の runner の settled は預かって捨て、取り下げの日誌を書かない', async () => {
      const { stores, runnerA, release, reattach } = await relocateRig('accept');
      runnerA.emit?.({
        type: 'settled',
        managerId: 'mgr-moved',
        requestId: 'stale-settled',
        withdrawn: { reason: '元の runner が畳んだ' },
      } as RunnerEvent);
      await drain();
      release();
      await reattach;
      await vi.waitFor(async () => {
        expect(
          (await exchangeTexts(stores)).filter((text) => text.includes('移送の最中に届いた古い')),
        ).toEqual([
          '[判断] [mgr-moved] （移送の最中に届いた古い runner の出来事のため無視。移送先は runner-b、この出来事は runner-a から）' +
            '移送の最中に届いた古い runner の settled を無視した',
        ]);
      });
      expect(await withdrawnEscalations(stores, 'stale-settled')).toBe(0);
    });

    it('移送が受理されなかった回、窓の間に届いた元の runner の settled は処理し直され、取り下げの日誌が1本残る', async () => {
      const { stores, runnerA, release, reattach } = await relocateRig('refuse');
      runnerA.emit?.({
        type: 'settled',
        managerId: 'mgr-moved',
        requestId: 'replayed-settled',
        withdrawn: { reason: '元の runner が畳んだ' },
      } as RunnerEvent);
      await drain();
      // 預かっている間は処理しない（窓が閉じるまで日誌に出ない）。
      expect(await withdrawnEscalations(stores, 'replayed-settled')).toBe(0);
      release();
      await reattach;
      await vi.waitFor(async () => {
        expect(await withdrawnEscalations(stores, 'replayed-settled')).toBe(1);
      });
    });

    it('同じ runner への復帰が受理された回に捨てた、古いセッションの closed', async () => {
      const { stores, runnerA, release, reattach } = await sameRunnerRig({
        generation: 'gen-new',
      });
      runnerA.emit?.({
        type: 'closed',
        managerId: 'mgr-same',
        status: 'lost',
        reason: '古いセッションが畳まれた',
        sessionGeneration: 'gen-old',
      });
      await drain();
      release();
      await reattach;
      await vi.waitFor(async () => {
        expect(
          (await exchangeTexts(stores)).filter((text) => text.includes('への復帰の resume の最中')),
        ).toEqual([
          '[判断] [mgr-same] （同じ runner runner-a への復帰の resume の最中に届いた、古いセッションの出来事のため無視。resume は受理された）' +
            'runner 側の終了イベント（status=lost）を受け取った: 古いセッションが畳まれた',
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 起動時の引き取り（`#resumeAfterRestart`）は、別の契機が resume 中なら窓を持たず、その窓を壊さない。
  // ---------------------------------------------------------------------------------------------
  it('起動時の引き取りは、別の契機（runner の取り直し）が resume 中の担当には窓を持たず、その窓が預けた出来事を早く流さない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-race', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    const resume = gateResume(runnerA);

    // 取り直しの `list`（1回目）を止めて、起動時の引き取りを先に像まで進めさせる。
    let listCalls = 0;
    let releaseFirstList!: () => void;
    const firstListGate = new Promise<void>((resolve) => {
      releaseFirstList = resolve;
    });
    let firstListEntered!: () => void;
    const firstListEnteredPromise = new Promise<void>((resolve) => {
      firstListEntered = resolve;
    });
    const originalList = runnerA.client.list.bind(runnerA.client);
    runnerA.client.list = async () => {
      listCalls += 1;
      if (listCalls === 1) {
        firstListEntered();
        await firstListGate;
      }
      return originalList();
    };

    // 起動時の引き取りが像を載せた直後（runner を引く所）で止める: 2回目の `list` を過ぎた後の最初の `get`。
    let releaseGet!: () => void;
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let getEntered!: () => void;
    const getEnteredPromise = new Promise<void>((resolve) => {
      getEntered = resolve;
    });
    let getHeld = false;
    fake.hooks.onGet = () => {
      if (listCalls < 2 || getHeld) return undefined;
      getHeld = true;
      getEntered();
      return getGate;
    };

    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    pools.push(pool);
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-a');
    await firstListEnteredPromise;
    const restoring = pool.restore();
    await getEnteredPromise;
    // 取り直しを進める: 像（起動時の引き取りが載せたもの）に対して resume を出し、同じ runner への復帰の窓を開く。
    releaseFirstList();
    await resume.entered;
    // 取り直しの窓の間に届いた closed は、その窓が預かる。
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-race',
      status: 'lost',
      reason: '旧セッションが畳まれた',
    });
    await drain();
    // 起動時の引き取りが resume へ進む（別の契機が resume 中なので `busy`）。窓を持つなら、ここで取り直しの窓を閉じて預けた closed を流してしまう。
    releaseGet();
    await restoring;
    await drain();
    expect((await jobOf(stores, 'mgr-race'))?.status).toBe('running');

    resume.release();
    await reattach;
    await drain();
    expect({
      status: (await jobOf(stores, 'mgr-race'))?.status,
      sessionsOnA: (await runnerA.client.list()).map((s) => s.managerId),
    }).toEqual({ status: 'running', sessionsOnA: ['mgr-race'] });
  });
});
