import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
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
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #1716 の「確かめていないこと」への回答（w3 の横断レビュー、#1703 の隣）。
 *
 * `abort()` / `vacate()` は「同じ委譲が await の間に別の runner へ移る」窓を
 * `record.job.runnerId` と突き合わせて塞いだ（#1716 本体、`manager-abort-moved.test.ts`）。
 * Issue #1716 はもう1つ、**`#onEvent` の `case 'closed'` / `case
 * 'resume_failed'` にも同じ形の穴があるのでは、と疑いを書き添えていた（自分では
 * 赤を取っていなかった）。
 *
 * ## なぜ同じ形の穴になりうるか
 *
 * `RunnerEvent`（`runnerEventSchema`）は、どの runner の SSE 接続から来たかを
 * 運ばない——`event.managerId` だけを頼りに `record`（`#records` の像。
 * `#load()` の共有により `abort()` / `#reattach` と同じオブジェクト）を探す。
 * `void this.#onEvent(event)` で起こされるので複数の出来事が並行に処理され
 * うる（`manager.ts` の `#onEvent` の doc）。`#reattach` が同じ委譲を
 * 別の runner へ引き取った**後**に、前の runner の SSE から遅れてこの
 * イベントが届いても、`case 'closed'` / `case 'resume_failed'` はそれまで
 * 「宛先が変わっていないか」を一度も確かめていなかった——`status ===
 * 'stopped'`（abort() 経由の終端）だけを見るガードはあったが、`#reattach`
 * 経由で「別の runner へ移って `running` のまま走り続けている」場合は
 * すり抜ける。
 *
 * ## 実測した実害（直す前に赤を取った）
 *
 * runner-a で走っていた委譲を `#reattach` が runner-b へ引き取った後、
 * runner-a の遅れた `closed`（`status: 'lost'`）を流すと:
 * - 台帳の `status` が `running` から `lost` へ巻き戻る
 * - **runner-b がいま現に握っている貸し出しが解放される**
 *   （`releaseLease` が `holder.runnerId` を確かめずに、そのとき台帳に
 *   載っている貸し出しを無条件に返していたため）
 *
 * 後者は前者よりも危険である——貸し出しが解放されると、**別の器がこの
 * 委譲を無条件で引き取れる**状態になる（走っている委譲が二重に走りうる、
 * roadmap M5 が fencing で防ごうとしている状態そのもの）。
 *
 * ## 直し方
 *
 * `#onEvent` に、その出来事がどの runner の接続から来たか（`fromRunnerId`。
 * `#connectTo` の閉包が持っている `runner.runnerId` をそのまま渡すだけで、
 * ワイヤの形（`RunnerEvent` のスキーマ）は変えていない）を渡すようにし、
 * `case 'closed'` / `case 'resume_failed'` の先頭で
 * `record.job.runnerId !== fromRunnerId` を確かめる——一致しなければ
 * （＝この委譲は既に別の runner へ移っている）、日誌にだけ残して台帳・
 * 貸し出しには一切触れない。`record.job.runnerId` が未記録（`undefined`）
 * の古いジョブは判定材料が無いので、これまでどおり処理する（能力を
 * 削らない）。
 *
 * **他の `case`（`session` / `report` / `ask` 等）には広げていない。** Issue
 * #1716 が名指しして疑ったのはこの2つだけで、他の分岐まで同じ確認を足すのは
 * この変更が答えるべき範囲を超える——広げるなら別に判断すること。
 *
 * ## ⚠️ 「不一致」だけでは足りなかった（レビューで発見・修正）
 *
 * 最初の実装は `record.job.runnerId !== fromRunnerId` だけで「移った」と
 * 判定していたが、これは**正しいイベントまで誤って捨てる**穴を持っていた。
 * `RunnerClient.runnerId` は `/health` を聞けるまで既定値 `'runner-primary'`
 * を名乗り（`runnerIdKnown` の doc）、`start()` は `input.cwd` が明示されて
 * いれば `/health` 前でも通るので、`job.runnerId` にこの既定値が焼かれたまま
 * 残ることがある——`record.job.runnerId` を書き直すのは `#resume` の1箇所
 * だけで、`start()` 経由の attach はここを通らない。そのとき**本当に同じ
 * runner から**届いた `closed`/`resume_failed` でも、`job.runnerId`
 * （既定値）と `fromRunnerId`（実 id）は文字列としては不一致になり、
 * 素朴な判定だと「移った」と誤読して捨ててしまう——台帳が `running` の
 * まま残る（直したかった穴と逆向きの、同じくらい悪い結果）。運用者が
 * runner の id を付け替えた後の既存の委譲も同じ形になる。
 *
 * **⟹ 捨てるのは「委譲が、いま名簿に居る別の runner へ移ったと分かって
 * いる」ときだけにする。** `record.job.runnerId` が `#registeredRunnerIds()`
 * （名簿にいま実際に居る id の集合。名乗っていない entry が1本でも在れば
 * `null` ＝判定不能）に含まれているときだけ「別の実在する runner を指して
 * いる」と言え、それでも `fromRunnerId` と食い違うなら本当に移った後だと
 * 判定できる。`#registeredRunnerIds()` が `null` のときは、既定値の可能性を
 * 否定できないので、従来どおり（＝以前の振る舞い＝安全側）でイベントを
 * 適用する。この歯（下の最後の `it`）はこの区別を直接測る。
 */
describe('#onEvent: 移った後に届く古い runner の出来事', () => {
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
    };
  }

  /**
   * `manager-abort-moved.test.ts` の `fakeRunner` と同じ形だが、`connect()` が
   * 受け取った `onEvent` を `emit` として外へ持ち出す（テストから runner 発の
   * 出来事を流すため）。
   */
  function fakeRunner(
    runnerId: string,
    workspacePath = '/work/project',
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
      workspacePath,
      async connect(onEvent) {
        holder.emit = onEvent;
      },
      async start(): Promise<{ cwd?: string }> {
        /* この試験群では使わない。 */
        return {};
      },
      async resume(command): Promise<{ cwd?: string }> {
        resumes.push(command);
        sessions.set(command.managerId, {
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        return {};
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

  /** runner-a → runner-b への引き取りを組み立て、両方の runner の emit を返す。 */
  async function setupRelocated(): Promise<{
    stores: ReturnType<typeof createMemoryStores>;
    runnerA: ReturnType<typeof fakeRunner>;
    runnerB: ReturnType<typeof fakeRunner>;
    pool: ReturnType<typeof createManagerPool>;
    inbox: InboxEvent[];
  }> {
    const stores = createMemoryStores();
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
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
    });

    // **`#ensureConnected()` を先に踏ませる。** `abort()` / `send()` はどちらも
    // 冒頭でこれを呼び、名簿に居る全 runner へ `connect()` する——これが
    // 素の pool が実際に SSE を張る唯一の経路である。存在しない managerId を
    // 使い、副作用（connect）だけを踏む。
    await pool.abort('mgr-does-not-exist');

    // runner-b が同じ委譲を引き取る（reattach）。
    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);
    const afterReattach = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(afterReattach?.runnerId).toBe('runner-b');
    expect(afterReattach?.status).toBe('running');
    expect(afterReattach?.lease?.runnerId).toBe('runner-b');

    return { stores, runnerA, runnerB, pool, inbox };
  }

  it('runner-b へ移った後に届く runner-a の古い closed は、台帳と貸し出しを巻き戻さない', async () => {
    const { stores, runnerA } = await setupRelocated();

    expect(runnerA.emit).toBeDefined();
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-race',
      status: 'lost',
      reason: 'runner-a が自分で畳んだ（遅延して届いた）',
    });
    // `void this.#onEvent(event, ...)` は fire-and-forget なので、解決まで
    // マイクロタスクを挟んで待つ。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    // **本題**: runner-b で現に走り続けている委譲を、古い runner-a の
    // closed が「終わった」ことにして巻き戻してはいけない。
    expect(after?.status).toBe('running');
    expect(after?.runnerId).toBe('runner-b');
    // **とりわけ重い実害**: runner-b がいま握っている貸し出しを解放しない
    // ——解放すると、別の器がこの委譲を無条件で引き取れる状態になる。
    expect(after?.lease?.runnerId).toBe('runner-b');
    expect(after?.lease?.releasedAt).toBeUndefined();
  });

  it('runner-b へ移った後に届く runner-a の古い resume_failed は、台帳を巻き戻さない', async () => {
    const { stores, runnerA } = await setupRelocated();

    expect(runnerA.emit).toBeDefined();
    runnerA.emit?.({
      type: 'resume_failed',
      managerId: 'mgr-race',
      sessionId: 'sess-before-relocate',
      reason: '前の会話を見つけられなかった（遅延して届いた）',
      recovered: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    // **本題**: runner-b で現に走り続けている委譲を、古い runner-a の
    // resume_failed が `lost` へ落としてはいけない。
    expect(after?.status).toBe('running');
    expect(after?.runnerId).toBe('runner-b');
    expect(after?.lease?.runnerId).toBe('runner-b');
    expect(after?.lease?.releasedAt).toBeUndefined();
  });

  /**
   * **レビューで見つかった反対向きの穴（上の「⚠️」節）を直接測る。**
   *
   * `job.runnerId` が `'runner-primary'`（`RunnerClient.runnerId` の既定値。
   * `/health` を聞く前の `start()` 経由の attach ではこの値のまま残る）で、
   * 名簿には `'runner-primary'` という id の runner が1台も居ない（実在する
   * のは `'runner-a'` だけ）状態を作る。この状態で `runner-a` から本物の
   * `closed` が届いたとき、`record.job.runnerId`（`'runner-primary'`）が
   * `#registeredRunnerIds()`（`{'runner-a'}`）に含まれないので「別の実在する
   * runner を指している」とは言えない——`fromRunnerId` との不一致だけを見て
   * 捨てると、この委譲は永遠に `running` のまま残ってしまう。
   */
  it(
    'job.runnerId が名簿に居ない既定値（runner-primary）のままでも、' +
      'いまの runner から届く closed は捨てずに適用する',
    async () => {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-default-id', 'runner-primary'));
      const fake = createFakeRegistry();
      // 名簿に居るのは runner-a だけ——runner-primary という id の runner は
      // 実在しない（`job.runnerId` が既定値のまま焼かれているだけ）。
      fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
      const runnerA = fakeRunner('runner-a');
      fake.addClient(runnerA.client);
      const inbox: InboxEvent[] = [];
      const pool = createManagerPool({
        stores,
        post: (event) => inbox.push(event),
        runners: fake.registry,
      });

      // `#ensureConnected()` を踏ませて `runnerA.emit` を得る（他のテストと同じ形）。
      await pool.abort('mgr-does-not-exist');
      expect(runnerA.emit).toBeDefined();

      runnerA.emit?.({
        type: 'closed',
        managerId: 'mgr-default-id',
        status: 'done',
        reason: '普通に終わった（runner-a 自身から）',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-default-id');
      // **本題**: 「不一致」だけで捨てていた旧実装ではここが `running`
      // のまま残っていた（誤って「移った」と判定したため）。名簿に
      // `runner-primary` が実在しないと確かめられる以上、このイベントは
      // 適用してよい。
      expect(after?.status).toBe('done');
    },
  );
});
