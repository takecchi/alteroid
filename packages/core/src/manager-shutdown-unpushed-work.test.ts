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
 * **台帳（`Job.lastUnpushedWorkObservation`）が、`shutdown_unpushed_work`
 * （Issue #1266 候補(C)——日常の redeploy。SIGTERM → `host.shutdown()` →
 * `session.stop()`。`closed` を出さない設計）でも実際に残ることと、既に新しい
 * 観測が乗っているときは古い値で上書きしないことを測る。**
 *
 * `manager-closed-unpushed-work.test.ts`（候補(2)）を複製した形——足場
 * （`manualRunner` / `runningManualSetup`）は同じものを、この歯専用に複製して
 * ある（同ファイルの doc と同じ理由——duplicated on purpose）。`closed()` の
 * 代わりに `shutdownUnpushedWork()` を送れる点だけが違う。
 *
 * ## 測る5つ
 *
 * 1. `shutdown_unpushed_work` の `unpushedWork: {kind:'ok', result}` が、
 *    台帳に `kind: 'observed'` として残る。`status` には触れない
 *    （`closed` と違い、この事象は終端を運ばない）
 * 2. `unpushedWork: {kind:'unavailable', reason}` が、台帳に
 *    `kind: 'unavailable'` として残る
 * 3. 既に新しい観測（`pool.unpushedWork()` 経由。`case 'report'` /
 *    `case 'tool_use'` の fire-and-forget と同じ書き込み経路）が乗っている
 *    とき、`shutdown_unpushed_work` が運んできた**古い**観測では上書きしない
 * 4.（対照）既存の観測より `shutdown_unpushed_work` の観測のほうが新しい
 *    ときは、ちゃんと上書きする——3のガードが「常に上書きしない」へ倒れて
 *    いないことを見る
 * 5. **この事象自体が一度も届かないとき、欄は触れられない**——`0件`や
 *    `unavailable` を新しく作らない（`AGENTS.md`「取れない軸に0の行を作る」
 *    と同じ注意。届かなかったことは、この欄が更新されないこと自体で表れる）
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  /** `pool.unpushedWork()` が呼ばれたときに返す値を差し替える。 */
  setUnpushedWorkResult(result: UnpushedWorkResult): void;
  shutdownUnpushedWork(
    managerId: string,
    unpushedWork:
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
    async start(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
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
    // 消えたことに気づけない（`manager-closed-unpushed-work.test.ts` と同じ
    // 作法）。
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
    shutdownUnpushedWork(managerId, unpushedWork) {
      // **`Host#shutdown()` 経由の `stop()` は runner の名簿からセッションを
      // 消すが、`closed` と違い status には触れない**（`manualRunner` の
      // `alive` はテストの都合の簡易な在庫なので、ここでは実物の
      // `#stopBody()` の全順序までは模していない——このファイルが測るのは
      // イベント1本の処理だけである）。
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      send({ type: 'shutdown_unpushed_work', managerId, unpushedWork });
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

describe('台帳の lastUnpushedWorkObservation が、shutdown_unpushed_work（Issue #1266 候補(C)）でも残る', () => {
  it('1. observed: shutdown_unpushed_work の unpushedWork（kind:ok）が、台帳に kind:observed として残る。status には触れない', async () => {
    const { pool, fake } = await runningManualSetup('mgr-observed');

    fake.shutdownUnpushedWork('mgr-observed', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/1266-shutdown-observation' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-observed');
    // **`closed` と違い、この事象は終端を運ばない**——status はまだ台帳の
    // 元の値（`running`）のまま。
    expect(listed.status).toBe('running');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1266-shutdown-observation' }],
    });

    await pool.stop();
  });

  it('2. unavailable: shutdown_unpushed_work の unpushedWork（kind:unavailable）が、台帳に kind:unavailable + reason として残る', async () => {
    const { pool, fake } = await runningManualSetup('mgr-unavailable');

    fake.shutdownUnpushedWork('mgr-unavailable', {
      kind: 'unavailable',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-unavailable');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      kind: 'unavailable',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    });

    await pool.stop();
  });

  it('3. 上書きガード: 既に新しい観測が乗っているとき、shutdown_unpushed_work が運ぶ古い観測では上書きしない', async () => {
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

    const beforeShutdown = await listedOf(pool, 'mgr-guard');
    expect(beforeShutdown.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });

    // **時計を戻してから、shutdown_unpushed_work が運ぶ観測を処理させる**——
    // `case 'shutdown_unpushed_work'` は自分の処理時点の `at`（`this.#now()`）
    // を使うので、これで「古い」観測になる。
    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.shutdownUnpushedWork('mgr-guard', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/stale-race' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // **上書きされていない**——古い観測（`feat/stale-race`）ではなく、
    // 先に乗っていた新しい観測（`feat/newer-observation`）のままである。
    const afterShutdown = await listedOf(pool, 'mgr-guard');
    expect(afterShutdown.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });

    await pool.stop();
  });

  it('4.（対照）shutdown_unpushed_work の観測のほうが新しいときは、ちゃんと上書きする', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-fresh', () => clock);

    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/older-observation' }],
    });
    await pool.unpushedWork('mgr-fresh');

    // **時計を進めてから shutdown_unpushed_work を処理させる**——今度は
    // shutdown 側が新しい。
    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    fake.shutdownUnpushedWork('mgr-fresh', {
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

  it('5. 届かなかった回: shutdown_unpushed_work を一度も送らなければ、欄は undefined のまま——0件を作らない', async () => {
    const { pool } = await runningManualSetup('mgr-never-arrived');

    const listed = await listedOf(pool, 'mgr-never-arrived');
    // **「取れなかった」（unavailable）にすら化けない。** 欄そのものが
    // 一度も更新されていない——`kind: 'unavailable'` という値を新しく
    // 作ってしまうと、「確かめて取れなかった」と「そもそも届いていない」が
    // 区別できなくなる（`AGENTS.md`「取れない軸に0の行を作る」）。
    expect(listed.lastUnpushedWorkObservation).toBeUndefined();

    await pool.stop();
  });
});
