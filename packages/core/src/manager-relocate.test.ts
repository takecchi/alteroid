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
import type { InboxEvent, Job, JobLease, WorkspaceLocator } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 落ちた runner の委譲を、別の runner へ移送する（#485 M5 PR5）。
 *
 * ## 前提（設計はここに書かない。要点だけ）
 *
 * 移送のプリミティブ（`#resume`）は元々あった——`runnerId` を照合せずに任意の
 * `RunnerClient` を受け、貸し出しの門（`#claimForResume`）を通し、最後に
 * `record.job.runnerId = runner.runnerId` で台帳の宛先を付け替える。足りな
 * かったのは「別の runner を渡す呼び出し元」だけだった。
 *
 * `#reattach` のジョブの走査は元々 `job.runnerId !== runnerId` を理由に
 * 別宛先のジョブを一律で見送っていた——これを緩めたのが本体である。緩めた
 * 条件は「記録された宛先（`job.runnerId`）が、名簿の上で `lost` と確かめ
 * られているときだけ」移送してよい、というもの。判断材料は
 * `RunnerLiveness`（`runner-protocol.ts`）の doc の逐語:
 *
 * > `unreachable` と `lost` は似て見えるが別物である。前者は「まだ開けていない」
 * > 宛先で、抱えている仕事は無い。後者は「開けていた」宛先で、走っていた仕事
 * > ごと黙った可能性がある——あとで移送の契機になるのはこちらだけである。
 *
 * 新しい梯子・新しい知らせは作っていない——`#reattach` が既に持っていた
 * 「貸し出しが生きていれば断って `#scheduleReattach` の梯子に乗る／成功したら
 * `#notifyRestored` を呼ぶ」の上に、移送かどうか（`relocating`）で `cause`
 * （`'runner'` か `'relocated'`）を出し分けるだけである。
 *
 * ## この試験が固定するもの
 *
 * 1. 移送が成立し、台帳の宛先が付け替わる
 * 2. 生きている宛先の仕事は触らない（`runner-sticky.test.ts` と対になる安全側）
 * 3. 名簿にその宛先の行が0本なら移送しない（「黙った」と確かめられていない）
 * 4. `job.runnerId === undefined` の古い行は移送しない
 * 5. 貸し出しが生きていれば移送しない（既存の関門がそのまま効く）
 * 6. マネージャー向けの一言（`restartNudge`）が locator を読む
 * 7. クローンの受信箱（`#notifyRestored`）に「別の器で開き直した」が出る
 * 8. `relocateFrom` は、落ちた宛先以外の `connected` な器へ取り直しを起こす
 *
 * ## 足場について
 *
 * `RunnerRegistry` は `createRunnerRegistry()`（本物）を使わない。本物は
 * `entries()` の `state` を実際の接続・heartbeat から計算するので、`lost` を
 * 挟むには時間経過そのものを模す必要があり、この試験が固定したい「名簿の
 * `state` が○○のとき」を直接には作れない。ここでは `RunnerRegistry` の
 * インターフェースをそのまま満たす偽物を書き、`entries()` が返す行を試験ごと
 * に差し替えられるようにする。
 */

/** 名簿の1行を組み立てる（`RunnerEntry` の必須欄はここで埋める）。 */
function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
  return {
    label,
    state,
    ...(runnerId === undefined ? {} : { runnerId }),
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

/**
 * `RunnerRegistry` の8メンバを満たす偽物。**この試験群で使うのは `get` /
 * `entries` の2つだけ**（`#reattach` が実際に読むのはこの2つである）。残りは
 * 型を満たすだけで、呼ばれたら「使わない」と分かる形にしてある。
 */
function createFakeRegistry(): {
  registry: RunnerRegistry;
  /** 試験ごとに push / state 書き換えで差し替える。 */
  entries: RunnerEntry[];
  /** `get(runnerId)` が返す `RunnerClient` を登録する。 */
  addClient: (client: RunnerClient) => void;
  /** `get()` に渡された runnerId を呼ばれた順に記録する（#8 の検証用）。 */
  gotten: string[];
} {
  const clients = new Map<string, RunnerClient>();
  const entries: RunnerEntry[] = [];
  const gotten: string[] = [];
  const registry: RunnerRegistry = {
    async list() {
      return [...clients.values()];
    },
    async get(runnerId) {
      gotten.push(runnerId);
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
    entries() {
      // **試験が直接 push / 変異させた行を、呼ばれるたびに読み直す。** コピーを
      // 返すのは、呼び出し側（`manager.ts`）が返り値を書き換えないことを
      // 前提にしないためである。
      return entries.map((entry) => ({ ...entry }));
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
    gotten,
  };
}

/**
 * 偽の `RunnerClient`。`swappableRunner`（`manager-workspace-nudge.test.ts`）・
 * `LeasedRunner`（`manager-lease.test.ts`）と同じ形。
 */
function fakeRunner(
  runnerId: string,
  workspacePath = '/work/project',
): { client: RunnerClient; resumes: RunnerResumeCommand[] } {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この試験群は hello イベントの配送経路を使わない（`reattachRunner` /
       * `relocateFrom` が直に `#reattach` を起こす）。 */
    },
    async start() {
      /* この試験群では使わない。 */
    },
    async resume(command) {
      resumes.push(command);
      sessions.set(command.managerId, {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      /* この試験群では使わない。 */
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
  return { client, resumes };
}

/** 走行中の委譲を組み立てる。`runnerId` は台帳の記録した宛先。 */
function jobWith(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
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
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

/** まだ TTL の中にある貸し出し（`manager-lease.test.ts` の `leaseHeldBy` の縮小版）。 */
function recentLease(runnerId: string, fence = 4): JobLease {
  const now = Date.now();
  return {
    runnerId,
    fence,
    grantedAt: new Date(now - 2_000).toISOString(),
    seenAt: new Date(now - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
  };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('落ちた runner の委譲を、別の runner へ移送する（#485 M5 PR5）', () => {
  it('移送が成立する：runner-a が lost、runner-b が connected なら、runner-b が resume を受け、台帳の runnerId が runner-b になる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-1', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    // **`relocateFrom`（roadmap M5 PR5 の新しい契機）を通す。** 落ちた宛先
    // （runner-a）を渡すと、いま繋がっている別の器（runner-b）へ取り直しを
    // 起こす。
    pool.relocateFrom('runner-a');
    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-1');
    expect(job?.runnerId).toBe('runner-b');

    await pool.stop();
  });

  /**
   * **⭐ ここが最重要である。** `runner-sticky.test.ts` は「他の器は1度も
   * 受けない」を固定している——フィルタを緩めた影響がいちばん出るのがここ
   * なので、`runner-a` がまだ `connected`（黙っていない）なら、runner-b が
   * 名乗っても resume を出さないことを固定する。
   */
  it('生きている宛先（connected）の仕事には resume を出さない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-2', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    // runner-b が名乗った（hello 相当）。
    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-2');
    expect(job?.runnerId).toBe('runner-a');

    await pool.stop();
  });

  it('名簿に runner-a の行が0本なら移送しない（「黙った」とまだ確かめられていない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-3', 'runner-a'));
    const fake = createFakeRegistry();
    // runner-a の行そのものが無い（runner-b しか名簿に居ない）。
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);

    await pool.stop();
  });

  it('job.runnerId が無い古いジョブは移送しない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-4', undefined));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);

    await pool.stop();
  });

  it('貸し出しが生きていれば移送しない（held-by-lease。既存の関門がそのまま効く）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-5', 'runner-a', { lease: recentLease('runner-a') }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-5');
    // 台帳の宛先も世代も動いていない（奪っていない）。
    expect(job?.runnerId).toBe('runner-a');
    expect(job?.lease?.fence).toBe(4);

    await pool.stop();
  });

  it('マネージャー向けの一言（restartNudge）が locator を読む：shared-volume は「中身は残っている」を含み、「走らせていた runner が黙った」で始まる', async () => {
    const stores = createMemoryStores();
    const workspace: WorkspaceLocator = { kind: 'shared-volume', path: '/mnt/shared' };
    await stores.jobs.putJob(jobWith('mgr-6', 'runner-a', { workspace }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const message = runnerB.resumes[0]?.message ?? '';
    expect(
      message.startsWith('[system] 走らせていた runner が黙ったので、別の器で続きを開いた。'),
    ).toBe(true);
    expect(message).toContain('中身は残っている');

    await pool.stop();
  });

  it('クローンの受信箱（manager_message/report）に「別の器で開き直した」が出る（#notifyRestored を通っている）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-7', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool, inbox } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const reports = inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('別の器で開き直した');

    await pool.stop();
  });

  it('relocateFrom は、落ちた宛先以外の connected な器へ取り直しを起こす（落ちた宛先自身には起こさない）', async () => {
    const stores = createMemoryStores();
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    // まだ一度も開けていない宛先（`unreachable`）——対象に入らないことも併せて見る。
    fake.entries.push(entryOf('runner-d', 'unreachable', 'runner-d'));
    const runnerB = fakeRunner('runner-b');
    const runnerC = fakeRunner('runner-c');
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const { pool } = setup(stores, fake.registry);

    pool.relocateFrom('runner-a');
    await expect.poll(() => fake.gotten.length, { timeout: 2000 }).toBeGreaterThanOrEqual(2);

    expect(fake.gotten).toContain('runner-b');
    expect(fake.gotten).toContain('runner-c');
    expect(fake.gotten).not.toContain('runner-a');
    expect(fake.gotten).not.toContain('runner-d');

    await pool.stop();
  });

  /**
   * **`job.runnerId` が無い行を止めているのは2つの門である。** `job.runnerId ===
   * undefined` で降りる門と、`#isLostRunner` の門である。上の「古いジョブは移送
   * しない」は後者だけでも通ってしまう——名簿の行がどれも `runnerId` を名乗って
   * いれば `#isLostRunner(undefined)` は行0本で false を返すからである。
   *
   * **⚠️ 名乗らないまま黙った宛先が名簿に立つと、そこが割れる。** `RunnerEntry`
   * の `runnerId` は任意なので、`{ runnerId: undefined, state: 'lost' }` の行は
   * 実在しうる——そのとき `#isLostRunner(undefined)` は真になり、後者の門は
   * 開く。**ここで見るのは前者の門そのものである。**
   */
  it('名乗らないまま黙った宛先が名簿に在っても、job.runnerId が無い行は移送しない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-9', undefined));
    const fake = createFakeRegistry();
    // **runnerId を名乗らないまま lost になった行。** これが在ると
    // `#isLostRunner(undefined)` は真を返す（行1本・すべて lost）。
    fake.entries.push(entryOf('名乗らない宛先', 'lost'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect(runnerB.resumes).toEqual([]);

    await pool.stop();
  });

  /**
   * **クローンへ届く報告は2つの部分でできている。** 見出し（「別の器で開き直した」）と、
   * workspace の1行である。上の「受信箱に出る」は見出ししか見ていないので、
   * **workspace の1行を出す条件が `'runner'` だけに戻っても気づけない**
   * ——移送のときだけ黙る、という壊れ方をする。ここでその1行を固定する。
   */
  it('クローンへの報告に workspace の1行も出る：shared-volume なら「コミット前の変更も残っている」', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-10', 'runner-a', {
        workspace: { kind: 'shared-volume', path: '/mnt/shared/proj' },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool, inbox } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    const reports = inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('別の器で開き直した');
    expect(reports[0]?.text).toContain('コミット前の変更も残っている');

    await pool.stop();
  });
});
