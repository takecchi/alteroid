import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **台帳（`Job.lastUnpushedWorkObservation`）が、`closed`（Issue #1266
 * 候補(2)——枠落ち・失敗でセッションが `closed`（`lost` / `failed`）になる
 * 経路。5つ目の呼び出し元）でも実際に残ることと、既に新しい観測が乗って
 * いるときは古い値で上書きしないことを測る。**
 *
 * `case 'report'` から自動で1回呼ばれる経路（Issue #1266 の (4)）は
 * `manager.test.ts` の「ターンが report で終わったとき unpushedWork を1回
 * 取る」が固定している。ここが固定するのはその先——`runner.ts` の
 * `RunnerSession#finish()` が先取りして `closed` イベントへ運んだ観測を、
 * `manager.ts` の `case 'closed'` が実際に台帳へ写すところと、上書きガード
 * （`isUnpushedWorkObservationAtLeastAsNewAs`）である。
 *
 * 足場（`manualRunner` / `runningManualSetup`）は
 * `manager-lastSystemError.test.ts` と同じ形を複製してある（同ファイルの
 * doc と同じ理由——duplicated on purpose）。`unpushedWork()` を実装して
 * 返せる点（`pool.unpushedWork()` 経由で「既存の観測」を先に作れるように
 * するため）と、`closed()` に `unpushedWork` を差し込める点だけが違う。
 *
 * ## 測る5つ
 *
 * 1. `closed`（`failed`）に `unpushedWork: {kind:'ok', result}` が載ると、
 *    台帳に `kind: 'observed'` として残る
 * 2. `closed` に `unpushedWork: {kind:'unavailable', reason}` が載ると、
 *    台帳に `kind: 'unavailable'` として残る
 * 3. `unpushedWork` 欄が丸ごと無い `closed`（古い runner）でも、境界
 *    （`runnerEventSchema`）を通り、台帳の `lastUnpushedWorkObservation` は
 *    （元々無ければ）`undefined` のまま——他の欄（`status` 等）は今までどおり
 *    書かれる
 * 4. 既に新しい観測（`pool.unpushedWork()` 経由。`case 'report'` /
 *    `case 'tool_use'` の fire-and-forget と同じ書き込み経路）が乗っている
 *    とき、`closed` が運んできた**古い**観測では上書きしない
 * 5.（対照）既存の観測より`closed`の観測のほうが新しいときは、ちゃんと
 *    上書きする——4のガードが「常に上書きしない」へ倒れていないことを見る
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  /** `pool.unpushedWork()` が呼ばれたときに返す値を差し替える。 */
  setUnpushedWorkResult(result: UnpushedWorkResult): void;
  closed(
    managerId: string,
    status: 'done' | 'lost' | 'failed',
    reason: string,
    unpushedWork?:
      { kind: 'ok'; result: UnpushedWorkResult } | { kind: 'unavailable'; reason: string },
  ): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  let unpushedWorkResult: UnpushedWorkResult | undefined;

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume() {
      /* この検証では使わない */
    },
    async send() {
      /* この検証では使わない */
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
    async unpushedWork() {
      return unpushedWorkResult;
    },
  };

  function send(raw: RunnerEvent): void {
    // **daemon の境界（`runnerEventSchema.safeParse`）を実際に通す。** スキーマに
    // 無い欄はここで黙って落ちるので、emit した中身だけを見ていると境界で
    // 消えたことに気づけない（`manager-closed-failed-system-error.test.ts` と
    // 同じ作法）。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  }

  return {
    runner,
    alive,
    setUnpushedWorkResult(result) {
      unpushedWorkResult = result;
    },
    closed(managerId, status, reason, unpushedWork) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      send({
        type: 'closed',
        managerId,
        status,
        reason,
        ...(unpushedWork === undefined ? {} : { unpushedWork }),
      });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId = 'mgr-quota',
  now?: () => number,
): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    ...(now === undefined ? {} : { now }),
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function listedOf(pool: ManagerPool, managerId: string) {
  const all = await pool.list();
  const found = all.find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

describe('台帳の lastUnpushedWorkObservation が、closed（Issue #1266 候補(2)）でも残る', () => {
  it('1. observed: closed の unpushedWork（kind:ok）が、台帳に kind:observed として残る', async () => {
    const { pool, fake } = await runningManualSetup('mgr-observed');

    fake.closed('mgr-observed', 'failed', '枠に当たって落ちた', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/1266-closed-observation' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-observed');
    expect(listed.status).toBe('failed');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1266-closed-observation' }],
    });

    await pool.stop();
  });

  it('2. unavailable: closed の unpushedWork（kind:unavailable）が、台帳に kind:unavailable + reason として残る', async () => {
    const { pool, fake } = await runningManualSetup('mgr-unavailable');

    fake.closed('mgr-unavailable', 'lost', 'セッションが落ちた', {
      kind: 'unavailable',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-unavailable');
    expect(listed.status).toBe('lost');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'unavailable',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    });

    await pool.stop();
  });

  it('3. 古い runner: unpushedWork 欄が丸ごと無い closed でも境界を通り、台帳は undefined のまま', async () => {
    const { pool, fake } = await runningManualSetup('mgr-legacy');

    // `fields` を渡さない——欄そのものが無い、古い runner の `closed` を模す。
    fake.closed('mgr-legacy', 'failed', '古い runner が落ちた');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-legacy');
    // **境界も処理も壊れていない**——`status` は今までどおり書かれる。
    expect(listed.status).toBe('failed');
    expect(listed.lastUnpushedWorkObservation).toBeUndefined();

    await pool.stop();
  });

  it('4. 上書きガード: 既に新しい観測が乗っているとき、closed が運ぶ古い観測では上書きしない', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-guard', () => clock);

    // **先に「新しい」観測を作る**（`case 'report'` / `case 'tool_use'` の
    // fire-and-forget と同じ書き込み経路——`pool.unpushedWork()` を直接呼ぶ）。
    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/newer-observation' }],
    });
    await pool.unpushedWork('mgr-guard');

    const beforeClosed = await listedOf(pool, 'mgr-guard');
    expect(beforeClosed.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });

    // **時計を戻してから、closed が運ぶ観測を処理させる**——`case 'closed'` は
    // 自分の処理時点の `at`（`this.#now()`）を使うので、これで「古い」観測に
    // なる。
    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.closed('mgr-guard', 'failed', '枠に当たって落ちた', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/stale-race' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // **上書きされていない**——古い観測（`feat/stale-race`）ではなく、
    // 先に乗っていた新しい観測（`feat/newer-observation`）のままである。
    const afterClosed = await listedOf(pool, 'mgr-guard');
    expect(afterClosed.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });
    // ただし `closed` 自体の処理（`status` 等）は普通に進む——ガードが
    // `unpushedWork` の1欄だけを止めていることの対照。
    expect(afterClosed.status).toBe('failed');

    await pool.stop();
  });

  it('5.（対照）closed の観測のほうが新しいときは、ちゃんと上書きする', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-fresh', () => clock);

    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/older-observation' }],
    });
    await pool.unpushedWork('mgr-fresh');

    // **時計を進めてから closed を処理させる**——今度は closed 側が新しい。
    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    fake.closed('mgr-fresh', 'failed', '枠に当たって落ちた', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/newest-observation' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = await listedOf(pool, 'mgr-fresh');
    expect(after.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newest-observation' }],
    });

    await pool.stop();
  });
});
