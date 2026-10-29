import { describe, expect, it } from 'vitest';

import { describeManagerOrigin } from './clone.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, Task } from './schema.js';
import type { Stores } from './store.js';
import { taskStatusForJob } from './task.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// #5469 P3: 委譲が taskId を持ち、委譲の状態が task の状態を動かす。

const AT = '2026-10-29T00:00:00.000Z';

function task(id: string, status: Task['status'] = 'queued'): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    origin: 'human',
    title: `${id} の仕事`,
    body: `${id} の本文`,
  };
}

/** 委譲が終わった（実時間の）後にクローンが task を動かした時刻。 */
function afterNow(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
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
    async stop() {
      /* この検証では使わない */
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    alive,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `poolStores` を渡すと、プールだけがそちらを見る（task ストアを壊した版を渡すため）。確かめは `stores` で読む。 */
async function setup(
  poolStores?: (stores: Stores) => Stores,
  existing?: Stores,
  now?: () => number,
) {
  const stores = existing ?? createMemoryStores();
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const seen = poolStores === undefined ? stores : poolStores(stores);
  const pool = createManagerPool({
    stores: seen,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores: seen, runners: registry }),
    ...(now === undefined ? {} : { now }),
  });
  await pool.restore();
  return { pool, fake, stores };
}

function report(managerId: string, status: 'done' | 'failed' = 'done'): RunnerEvent {
  return { type: 'report', managerId, text: '終わった', status } as RunnerEvent;
}

async function taskStatus(stores: Stores, id: string): Promise<Task['status'] | undefined> {
  return (await stores.tasks.get(id))?.status;
}

async function decisions(stores: Stores): Promise<string[]> {
  return (await stores.journal.list({ types: ['decision'] })).map((e) =>
    e.type === 'decision' ? e.decision : '',
  );
}

function ledgerJob(id: string, status: Job['status'], taskId: string): Job {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-primary',
    taskId,
    ...(status === 'running' || status === 'waiting_human' ? {} : { endedAt: AT }),
  };
}

describe('委譲の状態 → task の状態', () => {
  it.each([
    ['running', 'waiting'],
    ['waiting_human', 'waiting'],
    ['done', 'needs_decision'],
    ['failed', 'needs_decision'],
    ['lost', 'needs_decision'],
    ['stopped', 'needs_decision'],
  ] as const)('%s は %s', (job, expected) => {
    expect(taskStatusForJob(job)).toBe(expected);
  });
});

describe('manager_start の taskId を、委譲の状態が task へ写す', () => {
  it('⭐ 起こした直後に task は待ちになり、委譲が終わると判断待ちに戻る。task は閉じない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));

    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    expect((await s.stores.jobs.getJob(started.managerId))?.taskId).toBe('t-1');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    expect((await s.stores.tasks.get('t-1'))?.closedAt).toBeUndefined();
  });

  it('失敗で終わった委譲の task も判断待ちに戻る', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push(report(started.managerId, 'failed'));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('⭐ stopped（manager_stop）で終わった委譲の task も判断待ちに戻る', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    await s.pool.abort(started.managerId);
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('stopped');
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('⭐ lost になった委譲の task も判断待ちに戻る', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push({
      type: 'closed',
      managerId: started.managerId,
      status: 'lost',
      reason: '器から消えた',
    } as RunnerEvent);
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('lost');
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('⭐ resume（終わった委譲へ send）で、判断待ちの task は待ちへ戻る', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');

    await s.pool.send(started.managerId, '続きをお願い');
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('running');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  it('⭐ failed で像が外れた委譲を resume しても、判断待ちの task は待ちへ戻る（像のメモに頼らない）', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId, 'failed'));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');

    await s.pool.send(started.managerId, '続きをお願い');
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('running');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  it('⭐ 再起動した後（別のプールが台帳から像を作る）の resume でも、task は待ちへ戻る', async () => {
    const before = await setup();
    await before.stores.tasks.add(task('t-1'));
    const started = await before.pool.start({ request: '調べる', taskId: 't-1' });
    before.fake.push(report(started.managerId, 'failed'));
    await settle();

    await before.stores.jobs.updateJob(started.managerId, (job) => ({
      ...job,
      sessionId: 'sess-1',
    }));

    const after = await setup(undefined, before.stores);
    await after.pool.send(started.managerId, '続きをお願い');
    await settle();
    expect((await after.stores.jobs.getJob(started.managerId))?.status).toBe('running');
    expect(await taskStatus(after.stores, 't-1')).toBe('waiting');
  });

  it('クローンが閉じた task は、委譲が終わっても動かさない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    await s.stores.tasks.setStatus('t-1', 'cancelled', {
      by: 'clone',
      at: AT,
      reason: '要らなくなった',
    });

    s.fake.push(report(started.managerId));
    await settle();
    const closed = await s.stores.tasks.get('t-1');
    expect(closed?.status).toBe('cancelled');
    expect(closed?.closedReason).toBe('要らなくなった');
  });

  it('task が無くても委譲は起こす（状態を追わせないだけ）', async () => {
    const s = await setup();
    const started = await s.pool.start({ request: '調べる', taskId: 't-ghost' });
    expect(started.status).toBe('running');
    s.fake.push(report(started.managerId));
    await settle();
    expect((await s.stores.tasks.list({ includeClosed: true })).entries).toHaveLength(0);
  });

  it('taskId を渡さない委譲は task に触れない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる' });
    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('queued');
  });

  it('委譲が終わったあと、クローンが queued へ戻した task は、同じ委譲の次の書き込みで戻さない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    await s.stores.tasks.setStatus('t-1', 'queued', { by: 'clone', at: AT });

    // 状態の変わらない書き込み（2度目の同じ報告）
    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('queued');
  });

  it('⭐ 終わった後にクローンが waiting を置いた task は、同じ委譲の2度目の報告で needs_decision へ倒さない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    await s.stores.tasks.setStatus('t-1', 'waiting', { by: 'clone', at: afterNow() });

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  it('⭐ runner が done のセッションを持ったまま restore しても、クローンが置いた waiting を倒さない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    await s.stores.tasks.setStatus('t-1', 'waiting', { by: 'clone', at: afterNow() });
    // 再起動した別のプール。runner は done のセッションを持っている
    const rebooted = fakeRunner();
    rebooted.alive.push({
      managerId: started.managerId,
      status: 'done',
      cwd: '/work/project',
      request: '調べる',
      waiting: [],
    });
    const registry = createRunnerRegistry([rebooted.runner]);
    const pool = createManagerPool({
      stores: s.stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores: s.stores, runners: registry }),
    });
    await pool.restore();
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('done');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  it('endedAt は終端へ入ったときに1回だけ書き、終わった後の書き込みでは進めず、動き出すと消す', async () => {
    // 時計を注入して、実時間を待たずに「あとの書き込みで時刻が進んでも endedAt は動かない」を確かめる
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    expect((await s.stores.jobs.getJob(started.managerId))?.endedAt).toBeUndefined();

    s.fake.push(report(started.managerId));
    await settle();
    const first = (await s.stores.jobs.getJob(started.managerId))?.endedAt;
    expect(first).toBeDefined();

    clock.at += 60_000;
    s.fake.push(report(started.managerId));
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.endedAt).toBe(first);

    await s.pool.send(started.managerId, '続きをお願い');
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.endedAt).toBeUndefined();
  });

  it('⭐ 委譲が走っている間にクローンが queued へ戻した task は、走っている最中の書き込みで待ちへ戻さない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    await s.stores.tasks.setStatus('t-1', 'queued', { by: 'clone', at: AT });

    await s.pool.send(started.managerId, '追加の指示');
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('running');
    expect(await taskStatus(s.stores, 't-1')).toBe('queued');
  });

  it('⭐ 遷移は日誌に decision で残る（動かさなかったときは残らない）', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();

    const lines = (await decisions(s.stores)).filter((line) => line.includes('task t-1'));
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes('queued から waiting'))).toBe(true);
    expect(lines.some((line) => line.includes('waiting から needs_decision'))).toBe(true);

    s.fake.push(report(started.managerId));
    await settle();
    expect((await decisions(s.stores)).filter((line) => line.includes('task t-1'))).toHaveLength(2);
  });
});

describe('終端の同期が失敗したとき・デーモンが落ちたとき', () => {
  function failingTasks(stores: Stores): Stores {
    return {
      ...stores,
      tasks: {
        ...stores.tasks,
        setStatus: async (id, status, options) => {
          if (status === 'needs_decision') throw new Error('task ストアが落ちている');
          return stores.tasks.setStatus(id, status, options);
        },
      },
    };
  }

  it('⭐ task ストアが投げても委譲は終わり、失敗は日誌に残る', async () => {
    const s = await setup(failingTasks);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push(report(started.managerId));
    await settle();
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('done');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect((await decisions(s.stores)).some((line) => line.includes('合わせられなかった'))).toBe(
      true,
    );
  });

  it('⭐ 書く前の状態を読めずに task の同期を見送ったら、stderr に1行残す（task は動かさず、委譲は終わる）', async () => {
    let unreadable = false;
    const s = await setup((stores) => ({
      ...stores,
      jobs: {
        ...stores.jobs,
        getJob: async (id: string) => {
          if (unreadable) throw new Error('台帳が読めない');
          return stores.jobs.getJob(id);
        },
      },
    }));
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    unreadable = true;

    const lines = await captureStderr(async () => {
      s.fake.push(report(started.managerId));
      await settle();
    });
    expect((await s.stores.jobs.getJob(started.managerId))?.status).toBe('done');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    const traces = lines.filter((line) =>
      line.includes('委譲の書く前の状態を読み出せませんでした'),
    );
    // 読めなかった書き込みごとに1行（報告1回で台帳へ書く回数は実装の都合なので、件数は固定しない）
    expect(traces.length).toBeGreaterThanOrEqual(1);
    for (const trace of traces) {
      expect(trace).toContain(`job id=${started.managerId}`);
      expect(trace).toContain('task=t-1');
      expect(trace).toContain('台帳が読めない');
    }
  });

  it('⭐ 起動時に、終わった委譲に結び付いたまま waiting の task を needs_decision へ直す', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1', 'waiting'));
    await s.stores.jobs.putJob(ledgerJob('mgr-old', 'done', 't-1'));

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    expect((await decisions(s.stores)).some((line) => line.includes('起動時の直し'))).toBe(true);
  });

  it('起動時の直しは、走っている委譲が結び付いた task・クローンが動かした task には触れない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-run', 'waiting'));
    await s.stores.tasks.add(task('t-req', 'queued'));
    await s.stores.tasks.add(task('t-none', 'waiting'));
    await s.stores.jobs.putJob(ledgerJob('mgr-done', 'done', 't-run'));
    await s.stores.jobs.putJob(ledgerJob('mgr-run', 'running', 't-run'));
    await s.stores.jobs.putJob(ledgerJob('mgr-done-2', 'done', 't-req'));

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-run')).toBe('waiting');
    expect(await taskStatus(s.stores, 't-req')).toBe('queued');
    expect(await taskStatus(s.stores, 't-none')).toBe('waiting');
  });

  it('⭐ 起動時の直しは、委譲が終わった後にクローンが置いた waiting（task_set_status）を戻さない', async () => {
    const s = await setup();
    // 委譲は 09:00 に終わり、クローンが 10:00 に waiting へ置いた
    await s.stores.tasks.add({
      ...task('t-1', 'waiting'),
      updatedAt: '2026-10-29T10:00:00.000Z',
    });
    // 終わった後も updatedAt は進む（task より新しい）。基準は endedAt
    await s.stores.jobs.putJob({
      ...ledgerJob('mgr-old', 'done', 't-1'),
      updatedAt: '2026-10-29T12:00:00.000Z',
      endedAt: '2026-10-29T09:00:00.000Z',
    });

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    // 2回目以降の restore（takeOver・トークンの回復）でも同じ
    await s.pool.restore();
    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  it('⭐ 結び付いた終端の委譲に endedAt が読めない行が1つでもある task は、並び順によらず見送る', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1', 'waiting'));
    await s.stores.tasks.add(task('t-2', 'waiting'));
    const withoutEnd = (id: string, taskId: string): Job => {
      const job = ledgerJob(id, 'done', taskId);
      delete job.endedAt;
      return job;
    };
    // t-1: 読める行 → 読めない行。t-2: 読めない行 → 読める行（台帳の並びが逆でも見送る）
    await s.stores.jobs.putJob(ledgerJob('mgr-a', 'done', 't-1'));
    await s.stores.jobs.putJob(withoutEnd('mgr-b', 't-1'));
    await s.stores.jobs.putJob(withoutEnd('mgr-c', 't-2'));
    await s.stores.jobs.putJob(ledgerJob('mgr-d', 'done', 't-2'));

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(await taskStatus(s.stores, 't-2')).toBe('waiting');
  });

  it('⭐ 起動時の直しは、結び付いた委譲のうち最後に終わったものの後に動いていない task だけ直す', async () => {
    const s = await setup();
    // 古い委譲 09:00 → クローンが 10:00 に waiting へ → 新しい委譲 11:00 が終わった（task は取り残された）
    await s.stores.tasks.add({
      ...task('t-1', 'waiting'),
      updatedAt: '2026-10-29T10:00:00.000Z',
    });
    await s.stores.jobs.putJob({
      ...ledgerJob('mgr-old', 'done', 't-1'),
      endedAt: '2026-10-29T09:00:00.000Z',
    });
    await s.stores.jobs.putJob({
      ...ledgerJob('mgr-new', 'failed', 't-1'),
      endedAt: '2026-10-29T11:00:00.000Z',
    });

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });
});

describe('resume で同じ task に2本が走るとき', () => {
  it('⭐ 先に終わった1本は、走っている別の委譲がある間は task を判断待ちへ倒さない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const a = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(a.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');

    // A が終わったあとに B を同じ task へ起こし、A を resume する（入口の断りを通らない経路）
    const b = await s.pool.start({ request: '別の調べ物', taskId: 't-1' });
    await s.pool.send(a.managerId, '続きをお願い');
    await settle();
    expect((await s.stores.jobs.getJob(a.managerId))?.status).toBe('running');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    // B が先に終わっても、A が走っている間は待ちのまま
    s.fake.push(report(b.managerId));
    await settle();
    expect((await s.stores.jobs.getJob(b.managerId))?.status).toBe('done');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    // 最後の1本が終わると判断待ちへ
    s.fake.push(report(a.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });
});

describe('道具: manager_start の taskId', () => {
  function build(stores: Stores) {
    const started: unknown[] = [];
    const pool = {
      start: async (input: unknown) => {
        started.push(input);
        return { managerId: 'mgr-x', cwd: '/work', runnerId: 'runner-a' };
      },
    } as unknown as ManagerPool;
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      managers: pool,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    return {
      started,
      call: async (args: Record<string, unknown>) => {
        const tool = tools.find((entry) => entry.name === 'manager_start');
        if (tool === undefined) throw new Error('manager_start が無い');
        const reply = await tool.handler(args as never, {});
        return (reply.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      },
    };
  }

  it('開いている task の id は委譲へ渡す', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('t-1'));
    const b = build(stores);
    await b.call({ request: '調べる', taskId: 't-1' });
    expect(b.started).toEqual([expect.objectContaining({ taskId: 't-1' })]);
  });

  it('⭐ 無い task は、起こさず日誌も書かずに断る', async () => {
    const stores = createMemoryStores();
    const b = build(stores);
    const reply = await b.call({ request: '調べる', taskId: 't-ghost' });
    expect(reply).toContain('task t-ghost は無い');
    expect(b.started).toHaveLength(0);
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(0);
  });

  it('⭐ 閉じた task は断る', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('t-1'));
    await stores.tasks.setStatus('t-1', 'done', { by: 'clone', at: AT });
    const b = build(stores);
    const reply = await b.call({ request: '調べる', taskId: 't-1' });
    expect(reply).toContain('task t-1 は閉じている');
    expect(b.started).toHaveLength(0);
  });

  it('⭐ 走っている委譲が結び付いた task は、どの委譲が走っているかを添えて断る', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('t-1', 'waiting'));
    await stores.jobs.putJob(ledgerJob('mgr-run', 'running', 't-1'));
    await stores.jobs.putJob(ledgerJob('mgr-ask', 'waiting_human', 't-1'));
    const b = build(stores);
    const reply = await b.call({ request: '調べる', taskId: 't-1' });
    expect(reply).toContain('走っている委譲がある');
    expect(reply).toContain('mgr-run');
    expect(reply).toContain('mgr-ask');
    expect(b.started).toHaveLength(0);
  });

  it('終わった委譲しか結び付いていない task、別の task の走っている委譲は断らない', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('t-1', 'needs_decision'));
    await stores.jobs.putJob(ledgerJob('mgr-done', 'done', 't-1'));
    await stores.jobs.putJob(ledgerJob('mgr-other', 'running', 't-2'));
    const b = build(stores);
    await b.call({ request: '続き', taskId: 't-1' });
    expect(b.started).toHaveLength(1);
  });

  it('taskId を渡さなければ、これまでどおり起こす', async () => {
    const stores = createMemoryStores();
    const b = build(stores);
    await b.call({ request: '調べる' });
    expect(b.started).toHaveLength(1);
    expect(b.started[0]).not.toHaveProperty('taskId');
  });
});

describe('報告は、委譲が結び付いた task を名乗る', () => {
  it('会話の起点があっても無くても、task の id を1行で出す', () => {
    expect(
      describeManagerOrigin({ kind: 'conversation', conversationId: 'conv-1', taskId: 't-1' }),
    ).toContain('結び付いた task: t-1');
    expect(describeManagerOrigin({ kind: 'none', taskId: 't-1' })).toContain(
      '結び付いた task: t-1',
    );
  });

  it('⭐ 起点の会話が無くても taskId があれば、「task_say で書く」案内を出し、task 無しの手順（task_add で新しい会話を作る）は出さない', () => {
    const none = describeManagerOrigin({ kind: 'none', taskId: 't-1' });
    expect(none).toContain('結び付いた task へ `task_say` で書く');
    expect(none).toContain('task_set_status で done にする');
    expect(none).not.toContain('task_add で足すと新しい会話ができる');
    const conv = describeManagerOrigin({
      kind: 'conversation',
      conversationId: 'conv-1',
      taskId: 't-1',
    });
    expect(conv).toContain('結び付いた task へ `task_say` で書く');
    expect(conv).not.toContain('task_list で探し');
  });

  it('taskId が無い委譲は、task_list で探す・task_add で足す手順を出す', () => {
    expect(describeManagerOrigin({ kind: 'conversation', conversationId: 'conv-1' })).toContain(
      'task_list で探し',
    );
    expect(describeManagerOrigin({ kind: 'none' })).toContain(
      'task_add で足すと新しい会話ができる',
    );
  });

  it('⭐ taskId が無い起点の会話の案内は、manager_list の行と同じ手順・同じ語（task_list で探して task_say、無ければ task_add）', () => {
    const text = describeManagerOrigin({ kind: 'conversation', conversationId: 'conv-1' });
    expect(text).toContain(
      '人間へ知らせるなら、この会話を起点にした task を task_list で探して `task_say` で書く。無ければ task_add で足す。',
    );
    expect(text).not.toContain('結び付いた task〔');
    expect(
      describeManagerOrigin(
        { kind: 'conversation', conversationId: 'conv-1' },
        (_id, _full, ref) => ref,
      ),
    ).toContain('task_list で探した task へ task_say で書く。無ければ task_add');
  });

  it('結び付いていなければ、行そのものを出さない', () => {
    expect(describeManagerOrigin({ kind: 'conversation', conversationId: 'conv-1' })).not.toContain(
      '結び付いた task:',
    );
    expect(describeManagerOrigin({ kind: 'none' })).not.toContain('結び付いた task:');
  });
});
