import { describe, expect, it } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
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
 *
 * ## このファイルの2つ目の describe について（#669）
 *
 * 末尾の「器が入れ替わった後の manager_send」は関門の試験ではないが、**要る足場が
 * 1バイト違わず同じ**である（台帳の貸し出しが古いプロセスを指し、いま応えているのは
 * 別のプロセス）。別ファイルへ写すと偽 runner を丸ごと複製することになり、片方だけ
 * 直る形を自分で作ることになるので、ここへ置いている。
 */

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
  async start(): Promise<void> {}
  async resume(command: RunnerResumeCommand): Promise<void> {
    if (this.resumeFailure !== undefined) throw this.resumeFailure;
    this.resumes.push(command);
    this.hold(command.managerId);
  }
  async send(): Promise<void> {
    if (this.sendFailure !== undefined) throw this.sendFailure;
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
   * **#390 対照試験（併存していないときの経路が変わっていないこと）。**
   *
   * 併存を検出したときだけ `#pushProfile` と `runner.list()` を関門より前で
   * 止める——併存していない通常の取り直しでは、これまでどおり両方を呼ぶ。
   * ここを固定しないと、「呼ばない」側の変異（常に早期リターンする実装）が
   * この対照が無いテスト集合をすり抜ける。
   */
  it('併存していない通常の取り直しでは、pushProfile と list を今までどおり呼ぶ（対照）', async () => {
    const h = await harnessOf();
    await h.stores.profile.write('export SOME_TOKEN=abc');
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    await h.pool.list();
    expect(h.runner.emit).toBeTypeOf('function');
    // 直前の `list()` / 接続時の `#pushProfile` ぶんを引く。
    h.runner.setProfileCalled = 0;
    h.runner.listCalled = 0;

    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.runner.setProfileCalled).toBeGreaterThan(0);
    expect(h.runner.listCalled).toBeGreaterThan(0);

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

    /**
     * **#390 (i)。** `#reattach` は `runnerId` の文字列一致で相手を決めた**後**
     * （＝名簿の重複のどちらか一方が resolve された後）、関門（`#claimForResume`）
     * より前で `#pushProfile` と `runner.list()` を走らせていた。相手が誤解決
     * されている可能性がある以上、この2つは「誤った相手への副作用」になりうる
     * （`#pushProfile` は冗長な書き込み、`runner.list()` は誤った `alive` を
     * 作って断りの churn を生む）。**関門より前で併存を検出し、どちらの相手にも
     * 副作用を走らせない**ことをここで固定する。
     */
    it('併存下では #pushProfile も runner.list() も、名寄せで解決したどちらの相手へも走らない', async () => {
      const h = await harnessOf();
      const duplicate = await withDuplicate(h);
      await h.stores.profile.write('export SOME_TOKEN=abc');
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.list();
      expect(h.runner.emit).toBeTypeOf('function');
      // 接続時（`#connectTo`）に降ろした分を引く——ここは併存とは無関係の
      // 正当な1回である。
      h.runner.setProfileCalled = 0;
      duplicate.setProfileCalled = 0;
      h.runner.listCalled = 0;
      duplicate.listCalled = 0;

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(h.runner.setProfileCalled).toBe(0);
      expect(duplicate.setProfileCalled).toBe(0);
      expect(h.runner.listCalled).toBe(0);
      expect(duplicate.listCalled).toBe(0);
      // resume も出ていない（`#claimForResume` を複製せず、ここは関門の手前で
      // 引き返しているだけであることの傍証）。
      expect(h.runner.resumes).toEqual([]);
      expect(duplicate.resumes).toEqual([]);

      await h.close();
    });

    /**
     * **#390 (ii)。これが本題の歯である。**
     *
     * 併存は `held` と違って時間では解けない（人間が `ALTEROID_RUNNER_ID` を
     * 直すまで解けない）。**「初回だけ言う」（edge-triggered）にすると、人間が
     * その1回を見逃した後・デーモンを再起動した後は永久に見えなくなる**
     * （`apps/daemon/src/runner-client.ts` の再接続ログが `#lastLoggedDelayMs`
     * の dedup で同じ壊れ方をしている——本文参照）。だから併存の合図は `hello`
     * のたびに走る `#reattach` の**呼び出し回数ぶん**繰り返し出る必要がある
     * ——ここでは2回目の `hello` でも出ることを固定する。
     */
    it('併存の合図は2回目の #reattach（hello）でも出る（初回だけで終わらない）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.list();
      expect(h.runner.emit).toBeTypeOf('function');

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const first = (await h.journal()).filter((entry) => entry.type === 'decision');
      expect(first).toHaveLength(1);
      const firstText = first
        .map((entry) => (entry.type === 'decision' ? `${entry.decision}\n${entry.grounds}` : ''))
        .join('\n');
      expect(firstText).toContain('時間では解けない');
      expect(firstText).toContain('直し方: 器ごとに違う ALTEROID_RUNNER_ID');

      // **`held` の断り（`refusedBefore` の dedup）はここに乗せない。** 乗せると
      // 「初回だけ言う」に戻ってしまい、この歯が落ちなくなる。
      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = (await h.journal()).filter((entry) => entry.type === 'decision');
      expect(second).toHaveLength(2);

      expect(h.runner.resumes).toEqual([]);

      await h.close();
    });

    /**
     * **受信箱（クローンの受け口）へ届くこと自体を固定する（#200 段1後半）。**
     *
     * これまでの併存の試験は日誌（`#journal`）だけを見ていた——`held-by-lease`
     * の断りは日誌にしか書かれず、`#post`（受信箱）を一度も呼んでいなかった
     * （測った事実1）。ここでは `#claimForResume`（`restore()` が通る経路）が
     * 実際に `#post` を呼び、文面が answering 側の `runnerId` を使うこと
     * （`lease.runnerId` ではない。#209 と同じ理由）を固定する。
     */
    it('併存では受信箱へ知らせ、answering 側の runnerId を使う（lease.runnerId ではない）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      // **台帳の貸し出しはわざと別の runnerId を指させる**（食い違いを作る）。
      // `lease.ts` の `ambiguous` の doc: 名指しするのは `verdict.runnerId`
      // （＝ answering 側）であって `lease.runnerId` ではない——食い違ったまま
      // `lease.runnerId` を出すと、重複していない方の名前を報告してしまう。
      await h.stores.jobs.putJob(
        runningJob(leaseHeldBy('boot-1', 4, { runnerId: 'stale-runner-name' })),
      );

      await h.pool.restore();

      const reports = h.inbox.filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message',
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]?.managerId).toBe('mgr-1');
      expect(reports[0]?.text).toContain('runnerId=runner-primary');
      expect(reports[0]?.text).not.toContain('stale-runner-name');
      expect(reports[0]?.text).toContain('2 台');
      expect(reports[0]?.text).toContain('新しく起こし直さないこと');
      expect(reports[0]?.text).toContain('ALTEROID_RUNNER_ID');

      await h.close();
    });

    it('held（時間で解ける）では受信箱へ出さない（併存だけの扱いである）', async () => {
      const h = await harnessOf();
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.restore();

      expect(h.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);

      await h.close();
    });

    /**
     * **入りだけでは沈黙の意味が確定しない（レビューでの訂正）。**
     *
     * 「遷移のときだけ書く」を受信箱の post にそのまま当てて「入り」だけを
     * 出すと、併存が続いている間も、実際に解けた後も、同じ「その後は何も
     * 届かない」になる。読み手は受信箱だけからはどちらか区別できない
     * （Issue #308 と同じ形の穴）。ここでは「解けた」も出ること、かつ
     * 梯子（`hello` の繰り返し）が回っても「入り」「出」がそれぞれ1回しか
     * 出ないことを固定する。
     */
    it('併存が解けたら「解けた」を受信箱へ知らせる（入りと出、それぞれ1回ずつ）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.list();
      expect(h.runner.emit).toBeTypeOf('function');

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      let reports = h.inbox.filter((event) => event.type === 'manager_message');
      expect(reports).toHaveLength(1);

      // **梯子が回っても「入り」は増えない**（2回目の hello。churn を作らない）。
      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      reports = h.inbox.filter((event) => event.type === 'manager_message');
      expect(reports).toHaveLength(1);

      // 併存が解ける（2台目が居なくなる）。
      await h.registry.unregister('http://runner-dup:4518');
      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      reports = h.inbox.filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message',
      );
      expect(reports).toHaveLength(2);
      expect(reports[1]?.text).toContain('解けました');

      // **「解けた」も遷移でしか出ない**（もう一度 hello が来ても重ねて出さない）。
      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(2);

      await h.close();
    });

    /**
     * **測った事実3の歯。** 貸し出しを台帳へ書けなかっただけのとき
     * （`ALTEROID_RUNNER_ID` の問題ではない）に、併存と同じ「人間が
     * `ALTEROID_RUNNER_ID` 等を直すまで解けない」という言い方をしていた
     * （`claimableAt` の有無だけで見分けていたため。`leaseRefusal.kind` を
     * 導入する前の姿）。ここでは日誌・`manager_send` の応答のどちらも、
     * 台帳の書き込み失敗を併存の言い方と混ぜないことを固定する。
     */
    describe('台帳の書き込みが落ちただけのとき（併存ではない。測った事実3）', () => {
      it('日誌の言い方を併存と混ぜない', async () => {
        const h = await harnessOf();
        await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
        h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
        h.breakWrites('ディスクが埋まっている');

        await h.pool.restore();

        const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
        const text = decided
          .map((entry) => (entry.type === 'decision' ? entry.decision : ''))
          .join('\n');
        expect(text).toContain('引き取りを見送った');
        // **積極的に否定する。** 黙って `ALTEROID_RUNNER_ID` を出さないだけでは
        // 足りない——読み手が「触れていないから関係あるかも」と探しに行く余地が
        // 残る（測った事実3の害はまさにこれだった）。「その設定の問題ではない」
        // まで言い切ることで、存在しない設定の誤りを探しに行かせない。
        expect(text).toContain('ALTEROID_RUNNER_ID の問題ではない');
        expect(text).not.toContain('人間が ALTEROID_RUNNER_ID 等を直すまで解けない');
        expect(text).not.toContain('時間では解けない（人間が');
        expect(text).toContain('台帳の書き込みが一時的に失敗しただけ');

        // **併存の扱い（受信箱の通知）を誤って引き継がない。**
        expect(h.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);

        await h.close();
      });

      it('manager_send の応答でも ALTEROID_RUNNER_ID を名指ししない', async () => {
        const h = await harnessOf();
        await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
        h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
        h.breakWrites('ディスクが埋まっている');

        const result = await h.pool.send('mgr-1', '続けて');

        expect(result.outcome).toBe('unknown');
        expect(result.detail).toContain('新しく起こし直さないこと');
        expect(result.detail).toContain('ALTEROID_RUNNER_ID の問題ではない');
        expect(result.detail).not.toContain('人間が ALTEROID_RUNNER_ID 等を直すまで解けない');
        expect(result.detail).not.toContain('時間では解けない（人間が');
        expect(result.detail).toContain('台帳の書き込みが一時的に失敗しただけ');

        await h.close();
      });
    });
  });
});

/** 待機中（`done`）の委譲。**貸し出しは返されている**（`closed` が通った印）。 */
function doneJob(lease: JobLease | undefined, overrides: Partial<Job> = {}): Job {
  return { ...runningJob(lease), status: 'done', ...overrides };
}

/** 返却済みの貸し出し（`releaseLease` は `releasedAt` を立てるだけで持ち主を残す）。 */
function leaseReleasedBy(instanceId: string | undefined, fence = 4): JobLease {
  return leaseHeldBy(instanceId, fence, {
    releasedAt: new Date(Date.now() - 500).toISOString(),
  });
}

/**
 * 器の入れ替えを、待機中（`done`）のマネージャーへ伝える経路（Issue #669）。
 *
 * ## ここで守っているもの
 *
 * `done` は3枚のホワイトリスト（`#reattach` / `#noteMissingSessions` /
 * `decideRunnerSwapNotice`）すべてから同じ理由で外れる。**外れていること自体は
 * 意図である**（終わった委譲へ ⚠ を並べると、本当に困っている1本が埋もれる）。
 * だが外れた結果、器が入れ替わったことが**誰からも伝わらない** — その後で人間や
 * クローンが `manager_send` を打つと、そのマネージャーは `/workspace` が消えている
 * ことを知らないまま「続き」を書き始める。
 *
 * **だから伝えるのは「話しかけた回」だけである。** 3枚の境界は1枚も動かさず、
 * `send()` が resume から入り直すときにだけ1行を混ぜる。
 *
 * ## 判定の作法（`RunnerBacklogSnapshot.instanceSwapped` の踏襲）
 *
 * - **時刻ではなく `instanceId` 同士を直接比べる**（時刻の比較は初回観測を入れ替えと
 *   誤読する）
 * - **どちらか一方でも取れなければ「判定できない」**。取れないときに「入れ替わった」
 *   と言わない
 */
describe('器が入れ替わった後の manager_send（#669）', () => {
  it('done の委譲へ、器が入れ替わった後に送ると、入れ替えを告げる行が人間の言葉の前に付く', async () => {
    const h = await harnessOf();
    // 台帳の貸し出しは `boot-1`、いま応えているのは `boot-2`（＝入れ替わっている）。
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

    const result = await h.pool.send('mgr-1', '続きをやって');

    expect(result.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(1);
    const message = h.runner.resumes[0]?.message ?? '';
    // `[system]` の接頭辞と「手元を確かめよ」の趣旨（`restartNudge` と同じ側）。
    expect(message).toContain('[system]');
    expect(message).toContain('手元の状態を確かめよ');
    // **人間の言葉を置き換えない。混ぜるのである。**
    expect(message).toContain('続きをやって');
    // 順序も固定する（告げる行が先。後ろに付けると人間の指示に埋もれる）。
    expect(message.indexOf('[system]')).toBeLessThan(message.indexOf('続きをやって'));

    await h.close();
  });

  /**
   * **作業ディレクトリについて何を言えるかは `workspaceAfterSwap` が持つ。**
   * ここで別の判定を書くと、直したつもりが片方だけになる（`restartNudge` /
   * `cloneWorkspaceAfterSwapLine` と同じ理由）。locator を変えると文言が変わる
   * ことで、その1つを通っていることを押さえる。
   */
  it('作業ディレクトリの言い方は locator から引く（判定を二重に持たない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(
      doneJob(leaseReleasedBy('boot-1'), {
        workspace: { kind: 'git', repository: 'takecchi/alteroid', ref: 'main' },
      }),
    );

    await h.pool.send('mgr-1', '続きをやって');

    const message = h.runner.resumes[0]?.message ?? '';
    expect(message).toContain('takecchi/alteroid の main');
    expect(message).toContain('clone し直してから');
    // locator が `git` のときは「残っているとは限らない」と言わない（別の主張）。
    expect(message).not.toContain('残っているとは限らない');

    await h.close();
  });

  it('器が入れ替わっていなければ、その行は付かない（人間の言葉だけが渡る）', async () => {
    const h = await harnessOf();
    // 台帳の貸し出しも、いま応えているのも `boot-2`。
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-2')));

    await h.pool.send('mgr-1', '続きをやって');

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.message).toBe('続きをやって');

    await h.close();
  });

  /**
   * **判定できないときに嘘をつかない**（AGENTS.md「判定できないという3つ目の状態を
   * 持つ」）。3通りとも「入れ替わっていない」とは言えていない — だが「入れ替わった」
   * とも言えないので、告げない側へ倒す。
   */
  describe('判定できないときは告げない', () => {
    it('台帳の貸し出しが持ち主を名乗っていないとき', async () => {
      const h = await harnessOf();
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy(undefined)));

      await h.pool.send('mgr-1', '続きをやって');

      expect(h.runner.resumes).toHaveLength(1);
      expect(h.runner.resumes[0]?.message).toBe('続きをやって');

      await h.close();
    });

    it('いま応えている側が名乗らないとき', async () => {
      const h = await harnessOf({ silent: true });
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

      await h.pool.send('mgr-1', '続きをやって');

      expect(h.runner.resumes).toHaveLength(1);
      expect(h.runner.resumes[0]?.message).toBe('続きをやって');

      await h.close();
    });

    /**
     * 併存（同じ `runnerId` を名乗る器が2台以上。#200）。**どちらの `instanceId` と
     * 突き合わせるかを決める材料が無い** ——`#sighting` はこのとき `instanceId` を
     * 返さないので、この経路も自動で「判定できない」へ落ちる。
     */
    it('同じ runnerId を名乗る器が2台あるとき', async () => {
      const h = await harnessOf();
      const duplicate = new LeasedRunner('runner-primary');
      await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

      await h.pool.send('mgr-1', '続きをやって');

      // どちらが resume を受けたかは名寄せ次第なので、両方を見る。
      const messages = [...h.runner.resumes, ...duplicate.resumes].map(
        (command) => command.message,
      );
      expect(messages).toEqual(['続きをやって']);

      await h.close();
    });
  });

  /**
   * **2回目には付かない。** 告げた回の `#claimForResume` が貸し出しを新しい
   * `instanceId` で貸し直す（`grantLease`）ので、記録された持ち主は自動で追いつく。
   * ここを別に持たせると、更新を書き忘れた版が「毎回同じ1行が付く」形で残る。
   */
  it('同じ委譲へ2回目を送っても、同じ1行は付かない（貸し直しで持ち主が追いつく）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

    await h.pool.send('mgr-1', '続きをやって');
    expect(h.runner.resumes[0]?.message).toContain('[system]');
    // 台帳の持ち主が、いま応えているプロセスへ入れ替わっている。
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2' });

    /*
     * **2回目も resume から入り直させる。** そうしないと「resume を通らなかった
     * から付かなかった」だけになり、判定そのものを測れない——runner が
     * 「そのセッションは無い」と答える回（#563）を作って、同じ経路をもう一度通す。
     */
    h.runner.sendFailure = new RunnerHttpError('そのセッションは無い', 404);
    const second = await h.pool.send('mgr-1', 'もう一言');

    expect(second.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(2);
    expect(h.runner.resumes[1]?.message).toBe('もう一言');

    await h.close();
  });

  /**
   * **`running` へ二重に告げない。**
   *
   * `#reattach` は入れ替えの時点で `restartNudge` を渡して resume を出し、その中の
   * `#claimForResume` が貸し出しを新しい `instanceId` で貸し直している。だから
   * その後に `send()` が resume から入り直しても、ここの判定は成り立たない。
   *
   * **これは `status` で分岐した結果ではない**（判定は `done` と同じ1つを通る）。
   * 貸し直しが済んでいるという状態の帰結である——だから `#reattach` が断られた
   * （`held-by-lease`）回は貸し直していない＝まだ誰も告げていないので、`send()` が
   * 告げるのが正しい。
   */
  it('running は #reattach が既に告げているので、その後の send で二重に告げない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    await h.pool.list();
    expect(h.runner.emit).toBeTypeOf('function');
    // 猶予を過ぎてから取り直す（関門を通す）。
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // `#reattach` の側で既に告げている（この対照が空振りしていない証拠）。
    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.message).toContain('runner の器が作り直された');

    // そのうえで、resume から入り直す回（#563）をもう一度作る。
    h.runner.sendFailure = new RunnerHttpError('そのセッションは無い', 404);
    await h.pool.send('mgr-1', '追加の指示');

    expect(h.runner.resumes).toHaveLength(2);
    expect(h.runner.resumes[1]?.message).toBe('追加の指示');

    await h.close();
  });

  /**
   * **`status` / `live` / `sessionMissingSince` を1バイトも動かしていない。**
   *
   * 入れ替えを告げるかどうかで、外から見える3つの欄が変わってはいけない
   * （`isLive()` の契約も `done` の札も、この Issue の主張ではない）。
   * **告げた側と告げなかった側を並べて比べる** — 片側だけを見ると、両方が同じだけ
   * 壊れた変異を見逃す。
   */
  it('入れ替えを告げても、status / live / sessionMissingSince は告げない回と同じ', async () => {
    const swapped = await harnessOf();
    await swapped.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));
    await swapped.pool.send('mgr-1', '続きをやって');

    const same = await harnessOf();
    await same.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-2')));
    await same.pool.send('mgr-1', '続きをやって');

    const view = async (h: Harness) => {
      const summary = (await h.pool.list()).find((manager) => manager.managerId === 'mgr-1');
      return {
        status: summary?.status,
        live: summary?.live,
        sessionMissingSince: summary?.sessionMissingSince,
      };
    };

    // 告げた側で実際に1行が付いていること（この対照が空振りしていない証拠）。
    expect(swapped.runner.resumes[0]?.message).toContain('[system]');
    expect(same.runner.resumes[0]?.message).toBe('続きをやって');
    expect(await view(swapped)).toEqual(await view(same));

    await swapped.close();
    await same.close();
  });

  /**
   * **新しい往復を1つも足していない。** 判定の材料は名簿（`#sighting`。プロセス内の
   * `entries()` を読むだけ）と台帳の貸し出しだけで、どちらも `send()` が元から
   * 払っているものである。
   *
   * **絶対値ではなく差分で見る** — 名簿の heartbeat（10秒間隔）も `identity()` を
   * 通るので、絶対値はテストが走った長さに依存する。
   */
  it('判定のために新しい往復を1つも足していない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));
    // 接続と名乗りの分をここまでに済ませる（`send()` の中の `#ensureConnected`）。
    await h.pool.list();

    const before = {
      identity: h.runner.identityCalled,
      list: h.runner.listCalled,
      setProfile: h.runner.setProfileCalled,
    };
    await h.pool.send('mgr-1', '続きをやって');

    expect({
      identity: h.runner.identityCalled,
      list: h.runner.listCalled,
      setProfile: h.runner.setProfileCalled,
    }).toEqual(before);
    // 増えたのは resume の1本だけ（`send()` が元から払う往復）。
    expect(h.runner.resumes).toHaveLength(1);

    await h.close();
  });
});
