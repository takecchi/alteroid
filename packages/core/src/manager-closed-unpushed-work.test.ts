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

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  setUnpushedWorkResult(result: UnpushedWorkResult): void;
  holdUnpushedWork(): () => void;
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
  let unpushedWorkGate: Promise<void> | undefined;

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
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
      if (unpushedWorkGate !== undefined) await unpushedWorkGate;
      return unpushedWorkResult;
    },
  };

  function send(raw: RunnerEvent): void {
    // 境界（`runnerEventSchema.safeParse`）を実際に通す: スキーマに無い欄はここで落ちるため。
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
    holdUnpushedWork() {
      let release: () => void = () => undefined;
      unpushedWorkGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
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

    fake.closed('mgr-legacy', 'failed', '古い runner が落ちた');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-legacy');
    expect(listed.status).toBe('failed');
    expect(listed.lastUnpushedWorkObservation).toBeUndefined();

    await pool.stop();
  });

  it('4. 上書きガード: 既に新しい観測が乗っているとき、closed が運ぶ古い観測では上書きしない', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-guard', () => clock);

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

    // 時計を戻す: `case 'closed'` は処理時点の `at` を使うので、これで closed の観測が古くなる。
    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.closed('mgr-guard', 'failed', '枠に当たって落ちた', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/stale-race' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterClosed = await listedOf(pool, 'mgr-guard');
    expect(afterClosed.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ branch: 'feat/newer-observation' }],
    });
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

  it('6.（#2461）問い合わせの間に closed が ok を書いたら、遅れて返った unavailable で上書きしない', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-late', () => clock);

    const release = fake.holdUnpushedWork();
    const pending = pool.unpushedWork('mgr-late');

    clock = new Date('2026-09-25T00:05:00.000Z').getTime();
    fake.closed('mgr-late', 'failed', '枠に当たって落ちた', {
      kind: 'ok',
      result: {
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/closed-ok' }],
      },
    });
    // 実時間では待たず、closed の観測が台帳に届くまで waitFor する。
    await vi.waitFor(async () => {
      const listed = await listedOf(pool, 'mgr-late');
      if (listed.lastUnpushedWorkObservation?.kind !== 'observed') {
        throw new Error('closed の観測がまだ台帳に届いていない');
      }
    });

    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    release();
    expect((await pending).kind).toBe('unavailable');

    const after = await listedOf(pool, 'mgr-late');
    expect(after.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      worktrees: [{ branch: 'feat/closed-ok' }],
    });

    await pool.stop();
  });

  it('7.（#2461 対照）何も割り込まない通常の順では、問い合わせの結果がそのまま記録される', async () => {
    let clock = new Date('2026-09-25T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-plain', () => clock);

    const release = fake.holdUnpushedWork();
    const pending = pool.unpushedWork('mgr-plain');
    clock = new Date('2026-09-25T00:10:00.000Z').getTime();
    release();
    expect((await pending).kind).toBe('unavailable');

    const after = await listedOf(pool, 'mgr-plain');
    expect(after.lastUnpushedWorkObservation).toMatchObject({
      kind: 'unavailable',
      at: '2026-09-25T00:00:00.000Z',
    });

    await pool.stop();
  });
});

describe('fork が断られた回（pids 枯渇）の観測が、前に取れていた枝名を消さない（Issue #1266）', () => {
  const origin = { host: 'github.com', path: 'takecchi/alteroid.git' };
  const forkRefused = '確かめられなかった（git を起こせなかった: EAGAIN）';

  const forkRefusedResult = {
    cwd: '/work/project',
    worktrees: [
      {
        relativePath: '/tmp/mgr-pids/alteroid',
        branch: null,
        unpushedCommitCountUnknown: forkRefused,
        uncommittedChangeCountUnknown: forkRefused,
      },
    ],
  };

  async function observedWithBranch(managerId: string) {
    let clock = new Date('2026-10-10T00:00:00.000Z').getTime();
    const setup = await runningManualSetup(managerId, () => clock);

    clock = new Date('2026-10-10T00:05:00.000Z').getTime();
    setup.fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: '/tmp/mgr-pids/alteroid',
          branch: 'fix/1266-before-fork-refused',
          remoteOrigin: origin,
          unpushedCommitCount: 2,
          uncommittedChangeCount: 0,
        },
      ],
    });
    await setup.pool.unpushedWork(managerId);
    return { ...setup, setClock: (at: string) => (clock = new Date(at).getTime()) };
  }

  it('枝名と origin は前の観測から引き継ぎ、引き継いだ時刻を名乗る。件数はこの観測の「確かめられなかった」のまま', async () => {
    const { pool, fake, setClock } = await observedWithBranch('mgr-pids');

    setClock('2026-10-10T00:10:00.000Z');
    fake.closed('mgr-pids', 'failed', 'SIGABRT', { kind: 'ok', result: forkRefusedResult });
    await vi.waitFor(async () => {
      const listed = await listedOf(pool, 'mgr-pids');
      if (listed.lastUnpushedWorkObservation?.source !== 'closed') {
        throw new Error('closed の観測がまだ台帳に届いていない');
      }
    });

    const listed = await listedOf(pool, 'mgr-pids');
    expect(listed.lastUnpushedWorkObservation).toEqual({
      kind: 'observed',
      at: '2026-10-10T00:10:00.000Z',
      source: 'closed',
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: '/tmp/mgr-pids/alteroid',
          branch: 'fix/1266-before-fork-refused',
          remoteOrigin: origin,
          branchCarriedFromAt: '2026-10-10T00:05:00.000Z',
          unpushedCommitCountUnknown: forkRefused,
          uncommittedChangeCountUnknown: forkRefused,
        },
      ],
    });

    await pool.stop();
  });

  it('続けて取れなかった回でも、引き継いだ時刻は最初に枝名を見た観測のまま動かない', async () => {
    const { pool, fake, setClock } = await observedWithBranch('mgr-pids-again');

    fake.setUnpushedWorkResult(forkRefusedResult);
    setClock('2026-10-10T00:10:00.000Z');
    await pool.unpushedWork('mgr-pids-again');
    setClock('2026-10-10T00:15:00.000Z');
    await pool.unpushedWork('mgr-pids-again');

    const listed = await listedOf(pool, 'mgr-pids-again');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      at: '2026-10-10T00:15:00.000Z',
      worktrees: [
        {
          branch: 'fix/1266-before-fork-refused',
          branchCarriedFromAt: '2026-10-10T00:05:00.000Z',
        },
      ],
    });

    await pool.stop();
  });

  it('（対照）新しい観測で枝名が取れたら、それを採って引き継ぎの印を残さない', async () => {
    const { pool, fake, setClock } = await observedWithBranch('mgr-pids-recovered');

    fake.setUnpushedWorkResult(forkRefusedResult);
    setClock('2026-10-10T00:10:00.000Z');
    await pool.unpushedWork('mgr-pids-recovered');
    setClock('2026-10-10T00:15:00.000Z');
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [
        { relativePath: '/tmp/mgr-pids/alteroid', branch: 'fix/1266-after', remoteOrigin: origin },
      ],
    });
    await pool.unpushedWork('mgr-pids-recovered');

    const listed = await listedOf(pool, 'mgr-pids-recovered');
    const worktree =
      listed.lastUnpushedWorkObservation?.kind === 'observed'
        ? listed.lastUnpushedWorkObservation.worktrees[0]
        : undefined;
    expect(worktree?.branch).toBe('fix/1266-after');
    expect(worktree).not.toHaveProperty('branchCarriedFromAt');

    await pool.stop();
  });

  it('（対照）別の作業ツリーの枝名は引き継がない', async () => {
    let clock = new Date('2026-10-10T00:00:00.000Z').getTime();
    const { pool, fake } = await runningManualSetup('mgr-pids-other', () => clock);

    clock = new Date('2026-10-10T00:05:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '/tmp/mgr-pids/alteroid', branch: 'fix/1266-other-tree' }],
    });
    await pool.unpushedWork('mgr-pids-other');

    clock = new Date('2026-10-10T00:10:00.000Z').getTime();
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: '/tmp/mgr-pids-2/alteroid', branch: null }],
    });
    await pool.unpushedWork('mgr-pids-other');

    const listed = await listedOf(pool, 'mgr-pids-other');
    expect(listed.lastUnpushedWorkObservation).toMatchObject({
      worktrees: [{ relativePath: '/tmp/mgr-pids-2/alteroid', branch: null }],
    });
    const worktree =
      listed.lastUnpushedWorkObservation?.kind === 'observed'
        ? listed.lastUnpushedWorkObservation.worktrees[0]
        : undefined;
    expect(worktree).not.toHaveProperty('branchCarriedFromAt');

    await pool.stop();
  });
});
