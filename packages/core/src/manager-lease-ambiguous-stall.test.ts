import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobLease, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/** 名乗るプロセスを差し替えられる偽 runner。**受けた命令を全部記録する。** */
class LeasedRunner implements RunnerClient {
  // **併存（#200）を作るために runnerId を差し替えられるようにしてある。**
  // 既定は既存テストと同じ `runner-primary`——ここを変えても既存テストの
  // 期待値は1つも変わらない。
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  /** いまこの宛先に応えているプロセス（`/health` の `instanceId` に相当）。 */
  instanceId: string | undefined = 'boot-2';
  /** 次の resume で投げる失敗（世代で拒む 409 を作るため）。 */
  resumeFailure: unknown;
  /**
   * 次の `send` で投げる失敗（**#669**）。台帳が「繋がっている」と言っているのに
   * runner はそのセッションを持っていない回（#563）を作り、`send()` を resume の
   * 経路へもう一度通すために持つ。
   */
  sendFailure: unknown;
  // **#390: `#reattach` が関門より前で走らせる2つの副作用を数える。**
  // `setProfile` は `#pushProfile` が誤解決した相手へ環境プロファイルを
  // 押し込んでいないかを、`list` は誤った `alive` を作っていないかを見るため。
  setProfileCalled = 0;
  listCalled = 0;
  /**
   * **#669: 器の入れ替えの判定が新しい往復を足していないことを測るために数える。**
   * 名簿の heartbeat（10秒間隔）もここを通るので、**差分で見ること**（絶対値は
   * テストが走った長さに依存する）。
   */
  identityCalled = 0;

  constructor(runnerId = 'runner-primary') {
    this.runnerId = runnerId;
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    this.identityCalled += 1;
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
    };
  }

  hold(managerId: string): void {
    this.sessions.set(managerId, {
      managerId,
      status: 'running',
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  /** デーモンが張った受け口。**テストから runner 発の出来事を流すために持つ。** */
  emit: ((event: RunnerEvent) => void) | undefined;

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.emit = onEvent;
  }
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
    if (this.resumeFailure !== undefined) throw this.resumeFailure;
    this.resumes.push(command);
    this.hold(command.managerId);
    return {};
  }
  async send(): Promise<boolean> {
    if (this.sendFailure !== undefined) throw this.sendFailure;
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    this.listCalled += 1;
    return [...this.sessions.values()];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    this.setProfileCalled += 1;
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface Harness {
  pool: ManagerPool;
  registry: RunnerRegistry;
  stores: Stores;
  runner: LeasedRunner;
  /** 判定に使う時刻。テストが持つ（器の時計に依存した判定を書かないため）。 */
  advance: (ms: number) => void;
  /** ここから先の台帳への書き込みを失敗させる（**読みは通る**）。 */
  breakWrites: (reason: string) => void;
  /**
   * 預かってある生ログの読み出しを失敗させる／直す（**#669**）。
   *
   * `#resume` の `#loadSession` を `unreadable` へ落とすための口である。**関門
   * （`#claimForResume`）を通った後に失敗する枝を作れるのはここだけで**、
   * 「貸し出しだけ新しい器へ進んで、告げる1行は届かない」状態はここからしか作れない。
   * 効かせるにはジョブが `projectKey` を持っている必要がある（`#loadSession` は
   * それが無いと store を触らずに `absent` を返す）。
   */
  breakSessionLog: (reason: string) => void;
  healSessionLog: () => void;
  /** クローンの受信箱へ流れた分（黙って止めないことを確かめるため）。 */
  inbox: InboxEvent[];
  journal: () => Promise<JournalEntry[]>;
  close: () => Promise<void>;
}

async function harnessOf(options: { silent?: boolean } = {}): Promise<Harness> {
  const runner = new LeasedRunner();
  // **名乗らせないなら登録の前に決める。** 名簿は開けた瞬間に名乗りを聞くので、
  // 後から消しても「最後に名乗った値」が残る（＝判定材料が消えない）。
  if (options.silent === true) runner.instanceId = undefined;
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const base = createMemoryStores();
  /*
   * 台帳への書き込みを**途中から**壊せる足場。
   *
   * `failingJobWrite`（`testing.ts`）は最初から壊れているので、この試験が要る
   * 「走っていた委譲を台帳に置いてから壊す」を作れない（置く操作自体が失敗する）。
   */
  let writeFailure: string | undefined;
  /**
   * 生ログの読み出しを途中から壊せる足場（#669）。
   *
   * **既定では `null`（預かっていない）を返す。** `#loadSession` はそれを `absent`
   * として扱い resume は通るので、**この store を挿しただけでは既存のテストの
   * 期待値は1つも変わらない**（既存のジョブは `projectKey` を持たないので、
   * そもそもここへ到達しない）。
   */
  let sessionLogFailure: string | undefined;
  const stores: Stores = {
    ...base,
    jobs: {
      ...base.jobs,
      putJob: async (job) => {
        if (writeFailure !== undefined) throw new Error(writeFailure);
        await base.jobs.putJob(job);
      },
    },
    sessionStore: {
      append: async () => undefined,
      load: async () => {
        if (sessionLogFailure !== undefined) throw new Error(sessionLogFailure);
        return null;
      },
    },
  };
  // 名簿は器の時計で `instanceSince` を刻むので、判定の時計もそこから始める。
  let clock = Date.now();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    // **既定では何も置かれていないので中立。** `stores.profile.write(...)` で
    // 本文を置いたテストだけが `#pushProfile` に実際の `setProfile` 呼び出しを
    // させられる（`syncRunner` は空文字を「既に同じ」として素通しする）。
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock,
  });
  return {
    pool,
    registry,
    stores,
    runner,
    advance: (ms) => {
      clock += ms;
    },
    breakWrites: (reason) => {
      writeFailure = reason;
    },
    breakSessionLog: (reason) => {
      sessionLogFailure = reason;
    },
    healSessionLog: () => {
      sessionLogFailure = undefined;
    },
    inbox,
    journal: async () => base.journal.list({ limit: 100 }),
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

/** 走行中だった委譲を台帳に置く（貸し出しの持ち主を指定できる）。 */
function runningJob(lease: JobLease | undefined): Job {
  const at = new Date(Date.now() - 1_000).toISOString();
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: '走っていた仕事',
    request: '走っていた仕事の依頼',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...(lease === undefined ? {} : { lease }),
  };
}

function leaseHeldBy(
  instanceId: string | undefined,
  fence = 4,
  overrides: Partial<JobLease> = {},
): JobLease {
  return {
    runnerId: 'runner-primary',
    ...(instanceId === undefined ? {} : { instanceId }),
    fence,
    grantedAt: new Date(Date.now() - 2_000).toISOString(),
    seenAt: new Date(Date.now() - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 併存を早期検出で見送った後、併存が解けても `hello` が来なければ取り直されなかった
 * （Issue #3148。`#reattach` の早期検出が `retry` を立てずに return するので梯子が
 * 残らなかった）。直した後は、早期検出も梯子（間隔は上限に固定）を予約する。
 */
describe('併存が解けた後の取り直し（hello 無し / 有り）', () => {
  async function setup() {
    vi.useFakeTimers();
    const h = await harnessOf();
    const duplicate = new LeasedRunner('runner-primary');
    await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1', 4, { ttlMs: 1_000 })));
    // 併存のまま取り直しを1回走らせる（早期検出で見送る）。
    await h.pool.restore();
    await vi.advanceTimersByTimeAsync(5_000); // 梯子の取り直しを走らせ切る
    expect(h.runner.resumes).toEqual([]);
    // 併存が解ける。猶予も過ぎさせる（解けたこと以外に断る理由を残さない）。
    await h.registry.unregister('http://runner-dup:4518');
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    return { h, duplicate };
  }

  it('対照: 解けた後に hello を送れば取り直される', async () => {
    const { h } = await setup();
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.runner.resumes.length).toBe(1);
    await h.close();
  });

  it('併存が解けても hello が無ければ、梯子で取り直される（#3148）', async () => {
    const { h } = await setup();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.runner.resumes.length).toBe(1);
    await h.close();
  });

  it('併存が続く間に梯子が何回回っても、日誌と知らせは積まれず、取り直しもしない', async () => {
    vi.useFakeTimers();
    const h = await harnessOf();
    const duplicate = new LeasedRunner('runner-primary');
    await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1', 4, { ttlMs: 1_000 })));
    await h.pool.restore();
    await vi.advanceTimersByTimeAsync(5_000);
    const journalBefore = (await h.journal()).length;
    const inboxBefore = h.inbox.length;
    // 上限間隔（30秒）の梯子を何度も回す。
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect({
      journal: (await h.journal()).length,
      inbox: h.inbox.length,
      resumes: h.runner.resumes.length,
    }).toEqual({ journal: journalBefore, inbox: inboxBefore, resumes: 0 });
    await h.close();
  });
});
