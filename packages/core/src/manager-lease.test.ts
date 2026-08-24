import { describe, expect, it } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
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
  // **併存（#200）を作るために runnerId を差し替えられるようにしてある。**
  // 既定は既存テストと同じ `runner-primary`——ここを変えても既存テストの
  // 期待値は1つも変わらない。
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  /** いまこの宛先に応えているプロセス（`/health` の `instanceId` に相当）。 */
  instanceId: string | undefined = 'boot-2';
  /** 次の resume で投げる失敗（世代で拒む 409 を作るため）。 */
  resumeFailure: unknown;

  constructor(runnerId = 'runner-primary') {
    this.runnerId = runnerId;
  }

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

  /** デーモンが張った受け口。**テストから runner 発の出来事を流すために持つ。** */
  emit: ((event: RunnerEvent) => void) | undefined;

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.emit = onEvent;
  }
  async start(): Promise<void> {}
  async resume(command: RunnerResumeCommand): Promise<void> {
    if (this.resumeFailure !== undefined) throw this.resumeFailure;
    this.resumes.push(command);
    this.hold(command.managerId);
  }
  async send(): Promise<void> {}
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
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
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
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

  /**
   * **持ち主が名乗っていなかった貸し出しでも、時刻で言えることがある。**
   *
   * 名簿が `instanceId` を知る前に貸した委譲（開けた直後の名乗りの探りが落ちるとこう
   * なる）は、名前を突き合わせられない。それを一律に「判定できない」へ倒すと、**その
   * 委譲は以後ずっと無防備になり、器が入れ替わっても猶予を1秒も待たずに引き取られる。**
   *
   * いま応えているプロセスを**貸す前から**見ているなら、貸した相手はそのプロセスで
   * ある（台帳へ書くのはデーモン1つだけなので）。
   */
  it('名乗っていなかった貸し出しでも、貸す前から居るプロセスなら繋ぎ直しとして扱う', async () => {
    const h = await harnessOf();
    // いま応えているプロセス（登録時に観測）より**後**に貸した、という形にする。
    const grantedAt = new Date(Date.now() + 1_000).toISOString();
    await h.stores.jobs.putJob(
      runningJob(leaseHeldBy(undefined, 2, { grantedAt, seenAt: grantedAt })),
    );

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    // **繋ぎ直しなので世代を進めない**（進めると runner が持つ世代より新しくなる）。
    expect(h.runner.resumes[0]?.lease).toMatchObject({ fence: 2 });

    await h.close();
  });

  it('名乗っていなかった貸し出しで、貸した後に現れたプロセスなら入れ替えとして猶予を待つ', async () => {
    const h = await harnessOf();
    // 貸した時刻はこの器を見始めるより前（`leaseHeldBy` の既定は 2 秒前）。
    await h.stores.jobs.putJob(runningJob(leaseHeldBy(undefined, 2)));

    await h.pool.restore();
    expect(h.runner.resumes).toEqual([]);

    // 猶予を過ぎれば引き取る（見捨てない）。
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    await h.pool.reattachRunner('runner-primary');
    expect(h.runner.resumes).toHaveLength(1);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 3, instanceId: 'boot-2' });

    await h.close();
  });

  it('いま応えている側が名乗らないときは判定しない（それでも引き取る）', async () => {
    const h = await harnessOf({ silent: true });
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1', 2)));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    // 引き取ったので世代は進む（次に古い世代の命令が来たら runner が拒める）。
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 3 });

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
    // 台帳の貸し出しは前の持ち主のまま（書けなかったのだから当然である）。
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });
    /*
     * **像の側も巻き戻っていること。**
     *
     * ここを台帳（`jobOf`）だけで見ると、`putJob` が投げている以上どうやっても
     * 前の値のままなので**巻き戻しの実装を削っても緑になる**（実際に一度そういう
     * 検査になっていた）。像が進んだままだと、次の判定は「持ち主は自分（boot-2）」
     * という嘘の材料で走る — だから外から見える形（`list()`）で押さえる。
     */
    const summary = (await h.pool.list()).find((manager) => manager.managerId === 'mgr-1');
    expect(summary?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });

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

  /**
   * **器の入れ替えで実際に走るのはこの経路である。**
   *
   * `restore()` は像に載っている委譲を先頭で見送る（`#records.has` で `continue`）ので、
   * 入れ替えの前から走っていた委譲を拾うのは runner の名乗り（`hello`）を契機にした
   * 取り直しの側である。**ここに記録が無いと、「待っている」と「忘れている」が
   * 記録から区別できない**（`railway/README.md` がそう約束している）。
   */
  it('取り直しの経路でも、待っていることを日誌に残す（遷移のときだけ）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    /*
     * **受け口が張られていることを先に確かめる。**
     *
     * デーモンが `connect()` を呼ぶ契機は名簿の購読か `#ensureConnected` で、
     * この足場では名簿へ登録した後にプールを作っているので前者は起きない。
     * `list()` が後者を通す。**ここを確かめずに `emit?.()` を書くと、受け口が
     * 無いときにテストが黙って何もせず緑になる**（実際に一度そうなった）。
     */
    await h.pool.list();
    expect(h.runner.emit).toBeTypeOf('function');

    // 器が入れ替わって名乗り直した（新しい器にはこの委譲のセッションが無い）。
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.runner.resumes).toEqual([]);
    const decisions = (await h.journal()).filter((entry) => entry.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.type === 'decision' && decisions[0].decision).toContain(
      '引き取りを見送った',
    );

    // **同じ待ちで日誌を埋めない。** 梯子は挑み直し続けるので、毎回書くと1回の
    // 入れ替えで同じ行が何本も積まれ、本当に1回だけ起きたことが埋もれる。
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await h.journal()).filter((entry) => entry.type === 'decision')).toHaveLength(1);

    await h.close();
  });

  /**
   * **世代で拒まれた（409）を「戻せなかった」と同じ扱いにしない。**
   *
   * 409 が返るのは、その委譲を**自分より新しい世代の誰かが握っている**ときである
   * （＝そのセッションは生きていて、動かしている者が居る）。ここで台帳を `lost` に
   * して像から外すと、「戻せなかった」と読んだクローンが新しく起こし直し、
   * **fencing の失敗経路から二重実行へ到達する。**
   */
  it('世代で拒まれたら、台帳を lost にせず「起こし直すな」と知らせる', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 3)));
    h.runner.resumeFailure = new RunnerHttpError('resume が世代で拒まれた', 409);

    await h.pool.reattachRunner('runner-primary');

    // **終端にしない。** 走り続けているセッションの記録を殺さない。
    const summary = (await h.pool.list()).find((manager) => manager.managerId === 'mgr-1');
    expect(summary?.status).toBe('running');
    expect((await jobOf(h.stores))?.status).toBe('running');
    // **黙らない。** クローンには「起こし直すな」まで届く。
    const told = h.inbox
      .map((event) => (event.type === 'manager_message' ? event.text : ''))
      .join('\n');
    expect(told).toContain('新しく起こし直さないでください');
    expect(told).not.toContain('戻せなかった');
    const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
    expect(
      decided.map((entry) => (entry.type === 'decision' ? entry.decision : '')).join('\n'),
    ).toContain('取り直しを止めた');

    await h.close();
  });

  /**
   * **自己失効は「終わった」ではない。**
   *
   * runner が「デーモンと連絡が取れない」と言って自分で畳んだとき、そのプロセスからは
   * 続けられないが仕事はまだ owed である。`event.status`（`lost`）をそのまま台帳へ
   * 書くと `#restoreJobs` も `#reattach` も見送るので、**二重実行を止めた代わりに
   * 誰も拾わない仕事ができる。** それを起こさないことを固定する。
   */
  it('自己失効の closed では状態を動かさず、貸し出しだけ返して引き取り直せる', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 3)));
    h.runner.hold('mgr-1');
    await h.pool.restore();
    // 繋ぎ直しただけ（resume は出ていない）。
    expect(h.runner.resumes).toEqual([]);

    h.runner.emit?.({
      type: 'closed',
      managerId: 'mgr-1',
      status: 'lost',
      reason: 'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）。',
      selfFenced: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const after = await jobOf(h.stores);
    // **状態は動かさない**（`lost` にすると自動の引き取りが二度と触らない）。
    expect(after?.status).toBe('running');
    /*
     * **貸し出しは返す**（次の引き取りが猶予を待たない）。**消さずに印を立てる** —
     * 消すと世代（fence）まで消え、返却の知らせが遅れて届いた場合に runner が
     * 覚えている世代より小さい世代を渡すことになる（＝生きているセッションへの命令が
     * 拒まれ続ける）。
     */
    expect(after?.lease?.releasedAt).toEqual(expect.any(String));
    expect(after?.lease?.fence).toBe(3);
    // クローンへ黙っていない。
    const told = (await h.journal()).map((entry) =>
      entry.type === 'exchange' ? entry.text : entry.type,
    );
    expect(told.join('\n')).toContain('自己失効');

    /*
     * そして実際に引き取れる（誰も拾わない仕事にしない）。
     *
     * **`restore()` ではなく取り直し（`hello`）の経路で確かめる。** `restore()` は
     * 既に像を持っている委譲を見送る（`#records.has` で `continue`）ので、自己失効の
     * 後に効くのはこちら側である — 自己失効で像を外していないことと対になっている。
     * 実機でも、連絡が戻れば SSE が名乗り直す。
     */
    h.runner.sessions.delete('mgr-1');
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    // 返却は印であって消去ではない（世代を残す）。
    const stopped = (await jobOf(h.stores))?.lease;
    expect(stopped?.releasedAt).toEqual(expect.any(String));
    expect(stopped?.fence).toBe(9);

    await h.close();
  });

  /**
   * 併存（同じ `runnerId` を名乗る器が2台以上開いている。#200）。
   *
   * **`held`（貸し出し期限）とは別レイヤーの断りである。** `held` は「時間が
   * 経てば解ける」が、併存は人間が `ALTEROID_RUNNER_ID` を直すまで解けない。
   * `#sighting`（名簿から `LeaseSighting` を作るところ）が台数（`duplicates`）を
   * 見つけたら `judgeLease` が `ambiguous` を返し、`mayClaim` が `false` になる
   * ——ここではその一連が実際に resume を止めることと、クローンへ届く文言が
   * 「時間では解けない・何をすれば解けるか」を言うことを固定する。
   */
  describe('併存（同じ runnerId を名乗る器が2台以上。#200）', () => {
    /** 同じ `runnerId` を名乗る2台目を、別の label で名簿へ足す。 */
    async function withDuplicate(h: Harness): Promise<LeasedRunner> {
      const duplicate = new LeasedRunner('runner-primary');
      await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
      return duplicate;
    }

    it('併存では resume を1本も出さない', async () => {
      const h = await harnessOf();
      const duplicate = await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      const restored = await h.pool.restore();

      expect(restored).toEqual([]);
      expect(h.runner.resumes).toEqual([]);
      expect(duplicate.resumes).toEqual([]);
      // **貸し出しを書き換えていない**（`held` と同じ扱い。書けたことを条件にする
      // 「奪う操作」を通していない）。
      expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });

      await h.close();
    });

    /**
     * **`unheld` はここでも通る（残る穴。#200「6. 塞げない部分」）。**
     * 貸し出しの記録が無い委譲は、併存の下でも締め出さない——`unheld` 自身の
     * 既存の約束（この欄より前の委譲を締め出さない）を、併存の穴を塞ぐために
     * 壊さない、という意図した挙動である。
     */
    it('unheld（貸し出しの記録が無い）は併存でも従来どおり引き取る（残る穴）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(undefined));

      await h.pool.restore();

      expect(h.runner.resumes).toHaveLength(1);

      await h.close();
    });

    it('日誌に残る根拠が「時間では解けない」と分かる形である（held の言い方とは違う）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.restore();

      const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
      const text = decided
        .map((entry) => (entry.type === 'decision' ? `${entry.decision}\n${entry.grounds}` : ''))
        .join('\n');
      expect(text).toContain('引き取りを見送った');
      expect(text).toContain('時間では解けない');
      // 台数（併存であること自体）も分かる。
      expect(text).toContain('2 台');
      // `held` のときの言い方（期限が切れれば自動で挑み直す）はここでは出ない。
      expect(text).not.toContain('期限が切れたら自動で挑み直す');

      await h.close();
    });

    it('manager_send の応答が「起こし直すな」と、何をすれば解けるかを言う', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      const result = await h.pool.send('mgr-1', '続けて');

      expect(result.outcome).toBe('unknown');
      expect(result.detail).toContain('新しく起こし直さないこと');
      expect(result.detail).toContain('時間では解けない');
      // 「期限が切れれば自動で引き取る」と書いて待たせない（held の言い方と混ぜない）。
      expect(result.detail).not.toContain('期限が切れれば自動で引き取る');
      // 直し方（何をすれば解けるか）まで届く。
      expect(result.detail).toContain('ALTEROID_RUNNER_ID');

      await h.close();
    });
  });
});
