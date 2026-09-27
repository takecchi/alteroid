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
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 再現テスト（Issue #1716。w3 の横断レビュー、#1686 の隣）。
 *
 * #1686 は `vacate()` が「元の runner の `stop()` / 一覧確認を await している間に、
 * 別の runner が同じ委譲を `#reattach` で引き取っていた」場合の2つの穴
 * （貸し出しの二重解放・`attached=false` の上書き）を塞いだ。だが `abort()` は
 * `#confirmStoppedAndReleaseLease` を**同じ形で** await する、もう1つの呼び出し元
 * である（`vacate()` と同じ関数を共有すると manager.ts 自身が docstring で明言
 * している）。#1686 の diff は貸し出しの解放条件（`holder.runnerId ===
 * runner.runnerId`）を共有関数の中で直したので `abort()` 側にも効くが、
 * **`abort()` 自身が持つ、await の後の後始末**（`record.attached = false` /
 * `record.job.status = 'stopped'` / `#persist` / `#retire`）には
 * `vacate()` が足した「await の間に別の runner へ移っていたら触らない」という
 * ガード（`record.job.runnerId === runnerId`）が無かった。
 *
 * ## 再現する筋
 *
 * runner-a が `lost`（名簿上、開けていたが黙ったと確かめられた状態）になった
 * 委譲を、人間が `abort()` で止めようとする。`abort()` が runner-a の `stop()`
 * を await している間に、runner-b の名乗り（`#reattach` 相当。ここでは
 * `pool.reattachRunner('runner-b')` で直接起こす）が同じ委譲を引き取り、
 * resume に成功して `record.job.runnerId` / `record.job.status` を
 * `'runner-b'` / `'running'` に書き換える。
 *
 * `abort()` が起きて `#confirmStoppedAndReleaseLease` から戻ると、
 * runner-a には該当セッションがもう無いので `outcome === 'stopped'` になる
 * （#1686 の貸し出し解放そのものは新しい持ち主と一致しないので起きない）。
 * しかし `abort()` はそのまま `record.job.status = 'stopped'` を書き、
 * `#persist()` し、`#retire()` する——**runner-b へ移って現に走っている
 * 委譲を「止まった」ことにして台帳から消してしまう。**
 *
 * ## Issue #1703 との関係
 *
 * #1703 が足した `ManagerRecord.stopConfirmedAt`（止めた意思の印）は、
 * **`outcome === 'stopped'` が確定した後にしか立たない**——だからこの筋
 * （abort が runner-a の確認を待っている「間」に #reattach が resume する）
 * には効かない。印が立つ前に resume が終わってしまう。Issue #1716 は、
 * この印を「abort() の開始時（確認より前）」に前倒しする直しを要求する。
 */
describe('abort の await の間に、同じ委譲が別の runner へ引き取られたら', () => {
  /** 名簿の1行を組み立てる（`manager-vacate-moved.test.ts` と同じ形）。 */
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
  } {
    const clients = new Map<string, RunnerClient>();
    const entries: RunnerEntry[] = [];
    const registry: RunnerRegistry = {
      async list() {
        return [...clients.values()];
      },
      async get(runnerId) {
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
        /* この試験群では使わない（`abort()` を試すのであって `vacate()` ではない）。 */
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
    };
  }

  /** `manager-vacate-moved.test.ts` の `fakeRunner` と同じ形。 */
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
        /* この試験群は hello イベントの配送経路を使わない。 */
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

  function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });
    return { pool, inbox };
  }

  it('runner-b へ移って走り続けている委譲を「止まった」ことにしない', async () => {
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
    // runner-a は「開けていたが黙ったと確かめられた」（lost）——移送してよい状態。
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
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

    const aborting = pool.abort('mgr-race', undefined, 'human');
    await stopReached;
    // abort が runner-a の stop で待っている間に、runner-b が同じ委譲を
    // 引き取ろうとする。
    //
    // **この歯を書いた時点（Issue #1716 起票時、直す前）では、ここで
    // reattach の resume が必ず成功していた**（元の Issue の再現テストは
    // これを前提に `resumes` へ1件、台帳が `runner-b` / `running` に
    // 書き換わることを固定していた）。#1703 / #1716 を直した後は、`abort()`
    // が `#confirmStoppedAndReleaseLease` を待つ**前**に止めた意思の印
    // （`ManagerRecord.stopConfirmedAt`）を立てるので、`#reattach` 側の
    // `#resume` はチェックポイント1（`runner.resume()` を呼ぶ前の確認）で
    // この印を見て、resume そのものを出さずに `'stopped-meanwhile'` を返す
    // ようになった——**この歯が再現していた「reattach が実際に resume
    // してしまう」窓そのものが、直した後は構造的に閉じうる。**
    //
    // **だから、どちらの結果になっても本題（下の不変条件）は測れるように
    // しておく。** `resumes` が0件（チェックポイント1が防いだ）でも1件
    // （防ぎきれず、二重の網や既存の畳み直しが後から回収した）でも、
    // 弱めずにそれぞれの場合に応じた具体的な保証を確かめる。
    await pool.reattachRunner('runner-b');
    const resumedOnB = runnerB.resumes.length > 0;
    if (resumedOnB) {
      expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);
      // reattach が実際に resume していたなら、その時点で台帳は
      // 「runner-b で running」に書き換わっているはずである。
      const relocated = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
      expect(relocated?.runnerId).toBe('runner-b');
      expect(relocated?.status).toBe('running');
    }

    releaseStop();
    const result = await aborting;

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    // **本題**: runner-b へ移って走り続けている委譲を、abort() が「止まった」
    // ことにして台帳へ書いてはいけない。
    // 直し方は2通りありうる（abort を降りて runner-b に任せる／runner-b でも止める）ので、
    // どちらかを決め打ちせず、不変条件だけを測る:
    // 「台帳が stopped と言い、abort() が stopped と答えるなら、どの runner にもその委譲のセッションが無い」。
    const aliveOnB = (await runnerB.client.list()).some((s) => s.managerId === 'mgr-race');
    expect({ ledger: job?.status, answered: result.outcome, aliveOnB }).not.toMatchObject({
      aliveOnB: true,
      ledger: 'stopped',
    });
    if (result.outcome === 'stopped') expect(aliveOnB).toBe(false);

    // **チェックポイント1が実際に防いだ回（`resumedOnB` が偽）は、もう1段
    // 具体的に確かめる。** 止めた意思を優先した以上、runner-a 側は素直に
    // 止まっているはずで、`outcome` は `'stopped'` に、台帳も `'stopped'`
    // になるのが正しい——「不変条件を満たすために何もしなかった」逃げ道
    // （例えば `unknown` に倒れて何も確定させない）で満たしているのでは
    // ないことを、ここで区別する。
    if (!resumedOnB) {
      expect(result.outcome).toBe('stopped');
      expect(job?.status).toBe('stopped');
    }

    await pool.stop();
  });
});
