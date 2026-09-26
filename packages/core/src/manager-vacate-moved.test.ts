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
 * `RunnerRegistry` の9メンバを満たす偽物。**この試験群で使うのは `get` /
 * `entries` の2つだけ**（`#reattach` が実際に読むのはこの2つである）。残りは
 * 型を満たすだけで、呼ばれたら「使わない」と分かる形にしてある。
 *
 * **`vacate` だけは「使わない」にしていない。** 本物（`Registry#vacate`）と
 * 同じ効果（`entries` の該当行を `'vacating'` へ倒す）を持たせてある——
 * `ManagerPool.vacate()`（#485 PR-2）を試験するとき、`fake.entries.push` で
 * 手で先に `'vacating'` を置く形と、`pool.vacate()` を呼んで名簿側から
 * 倒させる形の両方を、同じ偽物で試せるようにするためである。
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
    vacate(runnerId) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId) entry.state = 'vacating';
      }
    },
    entries() {
      // **試験が直接 push / 変異させた行を、呼ばれるたびに読み直す。** コピーを
      // 返すのは、呼び出し側（`manager.ts`）が返り値を書き換えないことを
      // 前提にしないためである。
      return entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {
      /* この試験群では使わない（配置は検証対象ではない）。 */
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

/**
 * **vacate の await の間に、同じ委譲が別の runner へ引き取られたら、その委譲には触らない。**
 *
 * vacate は、走り始めに受け取った委譲について、元の runner の `stop()` と一覧の確認を
 * await する。その間に貸し出しが期限切れで、別の runner の名乗り（`#reattach`）が
 * 同じ委譲を引き取ると、`record.job.lease` は新しい runner の貸し出しに、
 * `record.job.runnerId` は新しい runner に変わる。以前は vacate がそのまま
 * 「元の runner の一覧に居ない＝止まった」と判定し、**新しい runner が握っている
 * 貸し出しを返していた**（さらに別の器が同じ委譲を引き取れる＝二重実行の芽）。
 * C のレビューが #1659 について挙げた疑い（`attached=false` の上書き）の調査で見つかった。
 */
describe('vacate の await の間に、同じ委譲が別の runner へ引き取られたら', () => {
  async function race() {
    const stores = createMemoryStores();
    // 元の runner（runner-a）の貸し出しは、既に期限が切れている。
    await stores.jobs.putJob(
      jobWith('mgr-race', 'runner-a', {
        lease: {
          runnerId: 'runner-a',
          fence: 4,
          grantedAt: '2026-01-01T00:00:00.000Z',
          seenAt: '2026-01-01T00:00:00.000Z',
          ttlMs: 60_000,
        },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopEntered: () => void = () => {};
    const stopReached = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    const originalStop = runnerA.client.stop;
    runnerA.client.stop = async (managerId: string) => {
      stopEntered();
      await stopGate;
      return originalStop(managerId);
    };

    const vacating = pool.vacate('runner-a');
    await stopReached;
    // vacate が runner-a の stop で待っている間に、runner-b が同じ委譲を引き取る。
    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);

    releaseStop();
    await vacating;
    return { pool, stores };
  }

  it('新しい runner が握っている貸し出しを返さない', async () => {
    const { pool, stores } = await race();
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.lease?.runnerId).toBe('runner-b');
    expect(job?.lease?.releasedAt).toBeUndefined();
    await pool.stop();
  });

  it('動いている委譲を live のままにする（attached を書き換えない）', async () => {
    const { pool } = await race();
    const summary = (await pool.list()).find((s) => s.managerId === 'mgr-race');
    expect(summary?.live).toBe(true);
    expect(summary?.runnerId).toBe('runner-b');
    await pool.stop();
  });
});
