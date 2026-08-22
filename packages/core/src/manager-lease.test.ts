import { describe, expect, it } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job, JobLease, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 貸し出し期限で引き取りを止める関門（roadmap M5 PR4 / 受け入れ基準6）。
 *
 * ## ここで守っているもの
 *
 * **器が入れ替わった直後に引き取ると、古い器でまだ手を動かしているマネージャーと
 * 合わせて同じ仕事が2本走る。** 器は入れ替えのときに古い器へ畳む猶予を与えてから
 * 殺すので、その猶予の中で引き取ってはいけない。逆に、猶予を過ぎても引き取らない
 * なら、台帳では走っているのに誰も走っていない仕事が残る（それも壊れている）。
 *
 * だから確かめるのは2つで、**片方だけでは足りない**:
 *
 * 1. 猶予の中では resume を1本も出さない（奪わない）
 * 2. 猶予を過ぎたら実際に resume を出す（見捨てない）
 *
 * ## 入れ替えの作り方（この試験の足場について）
 *
 * ハートビートを待って `instanceId` を変える形にはしていない。**台帳の貸し出しが
 * 古いプロセスを指していて、いま応えているのが別のプロセス**という状態そのものが
 * 判定の入力なので、そこを直に作る（`identity()` が最初から `boot-2` を名乗り、
 * 台帳の貸し出しは `boot-1` を持つ）。入れ替えの検知自体は `runner-swap.test.ts`
 * が別に固定している。
 */

/** 名乗るプロセスを差し替えられる偽 runner。**受けた命令を全部記録する。** */
class LeasedRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  /** いまこの宛先に応えているプロセス（`/health` の `instanceId` に相当）。 */
  instanceId: string | undefined = 'boot-2';

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
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

  async connect(): Promise<void> {}
  async start(): Promise<void> {}
  async resume(command: RunnerResumeCommand): Promise<void> {
    this.resumes.push(command);
    this.hold(command.managerId);
  }
  async send(): Promise<void> {}
  async answer(): Promise<boolean> {
    return false;
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
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
  journal: () => Promise<JournalEntry[]>;
  close: () => Promise<void>;
}

async function harnessOf(): Promise<Harness> {
  const runner = new LeasedRunner();
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
  const stores: Stores = {
    ...base,
    jobs: {
      ...base.jobs,
      putJob: async (job) => {
        if (writeFailure !== undefined) throw new Error(writeFailure);
        await base.jobs.putJob(job);
      },
    },
  };
  // 名簿は器の時計で `instanceSince` を刻むので、判定の時計もそこから始める。
  let clock = Date.now();
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
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

function leaseHeldBy(instanceId: string | undefined, fence = 4): JobLease {
  return {
    runnerId: 'runner-primary',
    ...(instanceId === undefined ? {} : { instanceId }),
    fence,
    grantedAt: new Date(Date.now() - 2_000).toISOString(),
    seenAt: new Date(Date.now() - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
  };
}

async function jobOf(stores: Stores): Promise<Job | undefined> {
  return (await stores.jobs.listJobs()).find((job) => job.id === 'mgr-1');
}

describe('引き取りの関門（貸し出し期限）', () => {
  /**
   * **これが受け入れ基準6 の「生きている器の仕事を奪わずに」の側である。**
   *
   * 器の入れ替えを観測しても、古い器はまだ畳む猶予の中に居る。ここで resume を
   * 出すと、古い器のマネージャーと合わせて同じ仕事が2本走る。
   */
  it('入れ替え直後は resume を1本も出さない（猶予の中では奪わない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    const restored = await h.pool.restore();

    expect(h.runner.resumes).toEqual([]);
    expect(restored).toEqual([]);
    // **貸し出しを書き換えていない**（世代を進めると、古い器の命令が拒まれ始める）。
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });
    // **黙って見送らない。** 判断として日誌に残る（根拠つき）。
    const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
    expect(decided.map((entry) => entry.decision).join('\n')).toContain('引き取りを見送った');

    await h.close();
  });

  /**
   * **見捨てないことも同じくらい重要である。** 猶予を過ぎたら引き取る — 過ぎても
   * 引き取らないなら、台帳では走っているのに誰も走っていない仕事が残る。
   */
  it('畳む猶予を過ぎたら引き取り、世代を1つ進めて runner へ渡す', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    const restored = await h.pool.restore();

    expect(restored.map((manager) => manager.managerId)).toEqual(['mgr-1']);
    expect(h.runner.resumes).toHaveLength(1);
    // 渡した世代は台帳の世代と一致し、前の世代より新しい。
    expect(h.runner.resumes[0]?.lease).toEqual({ fence: 5, ttlMs: 10 * 60_000 });
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2', fence: 5 });

    await h.close();
  });

  /**
   * **繋ぎ直しは奪う話ではない。** 同じプロセスが応えているなら世代を進めない —
   * 進めると台帳の世代が runner の持つ世代より新しくなり、次の命令が拒まれる。
   */
  it('持ち主が同じプロセスなら、世代を進めずに戻す', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 7)));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.lease).toEqual({ fence: 7, ttlMs: 10 * 60_000 });
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2', fence: 7 });

    await h.close();
  });

  /**
   * この欄が無かった頃のジョブと、`instanceId` を名乗らない runner のジョブ。
   * **永久に引き取れなくすると能力の削除になる**（north_star 禁止1）。
   */
  it('貸し出しの記録が無いジョブは、今までどおり引き取る', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(undefined));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 1, instanceId: 'boot-2' });

    await h.close();
  });

  it('持ち主が名乗っていなかったジョブは判定できないので引き取る（奪っていないとは言わない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy(undefined, 2)));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    // 引き取ったので世代は進む（次に古い世代の命令が来たら runner が拒める）。
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 3, instanceId: 'boot-2' });

    await h.close();
  });

  /**
   * **奪う操作だけは、台帳へ書けたことを条件にする。**
   *
   * 貸し出しが台帳に載らないまま走らせると、次の引き取りは「誰も握っていない」と
   * 読む＝同じ委譲を無条件に奪える状態を作る。台帳が書けなくても委譲を続けるという
   * 既存の判断（`#persist`）は、**奪う操作には広げない**。
   */
  it('貸し出しを台帳へ書けないときは引き取らない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    h.breakWrites('ディスクが埋まっている');

    await h.pool.restore();

    // **奪う操作は出さない。** 台帳が書けないまま走らせると、次の契機が同じ委譲を
    // 無条件で奪える状態（貸し出しの記録が無い）になる。
    expect(h.runner.resumes).toEqual([]);
    // 台帳の貸し出しは前の持ち主のまま（書けなかったのだから当然だが、**像の側も
    // 巻き戻していること**をここで固定する。像だけ進むと、次の判定が嘘の材料で走る）。
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });

    await h.close();
  });

  /**
   * **「まだ」と「無理」を言い分ける。** クローンが読むのはこの文であって、内部の
   * 真偽値ではない。同じ文言にすると、待てば通る委譲を新しく起こし直して**同じ仕事が
   * 2本になる**（この関門が防ごうとしているものそのもの）。
   */
  it('manager_send は「まだ前の器が握っている」と言い、起こし直すなと明示する', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    const held = await h.pool.send('mgr-1', '続けて');

    expect(held.outcome).toBe('unknown');
    expect(held.detail).toContain('前の器が握っている');
    expect(held.detail).toContain('新しく起こし直さないこと');
    expect(h.runner.resumes).toEqual([]);

    // 期限が切れれば、同じ呼びが通る（断りが恒久化しない）。
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    const delivered = await h.pool.send('mgr-1', '続けて');
    expect(delivered.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(1);

    await h.close();
  });

  it('止まったと確かめた委譲は貸し出しを返す（次の引き取りが猶予を待たない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 9)));
    h.runner.hold('mgr-1');
    await h.pool.restore();

    const result = await h.pool.abort('mgr-1', '確かめるため', 'clone');
    expect(result.outcome).toBe('stopped');
    expect((await jobOf(h.stores))?.lease).toBeUndefined();

    await h.close();
  });
});
