import { describe, expect, it } from 'vitest';

import { describeManagerOrigin, ORIGIN_NO_TASK_GUIDE } from './clone-batch-prompts.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, Task } from './schema.js';
import type { Stores } from './store.js';
import { taskStatusForJob } from './task.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// #5469 P3: 委譲が taskId を持ち、委譲の状態が task の状態を動かす。

const AT = '2026-10-29T00:00:00.000Z';

// 報告由来の report(done) から見回りが task を倒すまでの猶予（`TASK_FOLLOW_GRACE_MS` の値を書き写して固定する: 値が動いたら試験が知らせる）
const GRACE_MS = 30 * 60_000;

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
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent;
    },
    async list() {
      return [...alive];
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
  });
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
  // 経緯（猶予の PR）: 以前は report(done) の直後に needs_decision を期待していた。報告由来の done（ターンの終わり）は task を即時には倒さず、
  // 猶予（30 分）を過ぎた見回りが倒すようになったので、「終わると判断待ちに戻る」を猶予の後の見回りで確かめる形へ変えた（task が戻ること自体は変わらない）
  it('⭐ 起こした直後に task は待ちになり、委譲が終わると（猶予の後の見回りで）判断待ちに戻る。task は閉じない', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));

    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    expect((await s.stores.jobs.getJob(started.managerId))?.taskId).toBe('t-1');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
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

  // 経緯（猶予の PR）: report(done) 直後の needs_decision は猶予の後の見回りで作る形へ変えた（猶予内の send は task を動かさない: 猶予の試験が持つ）。判断待ちから待ちへ戻ることは変わらない
  it('⭐ resume（終わった委譲へ send）で、判断待ちの task は待ちへ戻る', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
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

  // 経緯（猶予の PR）: 最初の needs_decision は猶予の後の見回りで作る形へ変えた。クローンが置いた waiting を、2度目の報告も、その後の見回りも倒さないことは変わらない
  it('⭐ 終わった後にクローンが waiting を置いた task は、同じ委譲の2度目の報告・その後の見回りで needs_decision へ倒さない', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    await s.stores.tasks.setStatus('t-1', 'waiting', { by: 'clone', at: afterNow() });

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  // 経緯（猶予の PR）: 猶予の内の restore は何も倒さないので、時計を猶予の後へ進めても倒さないことを確かめる形にした（そうしないと、猶予のせいで緑なのかクローンの置いた waiting を見たから緑なのか分からない）
  it('⭐ runner が done のセッションを持ったまま、猶予を過ぎて restore しても、クローンが置いた waiting を倒さない', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    // 猶予の後の見回りが倒した後で、クローンが waiting を置く（倒れる前に置いても、状態が同じなので更新時刻が進まず、置いたことにならない）
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    await s.stores.tasks.setStatus('t-1', 'waiting', { by: 'clone', at: afterNow() });
    // 再起動した別のプール。runner は done のセッションを持っている
    const rebooted = fakeRunner();
    rebooted.alive.push({
      liveBackgroundTasks: 0,
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
      now: () => clock.at,
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

  // 経緯（猶予の PR）: needs_decision への遷移は猶予の後の見回りで起きるので、時計を進めて repairStrandedTasks を呼んでから数える（遷移の件数は変わらず 2 件）
  it('⭐ 遷移は日誌に decision で残る（動かさなかったときは残らない）', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();

    const lines = (await decisions(s.stores)).filter((line) => line.includes('task t-1'));
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes('queued から waiting'))).toBe(true);
    expect(lines.some((line) => line.includes('waiting から needs_decision'))).toBe(true);
    // Web が SSE で task の一覧を取り直す手がかり
    const taskDecisions = (await s.stores.journal.list({ types: ['decision'] })).filter(
      (entry) => entry.type === 'decision' && entry.decision.includes('task t-1'),
    );
    for (const entry of taskDecisions) {
      expect(entry.type === 'decision' && entry.target).toEqual({ kind: 'task', id: 't-1' });
    }

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

  // 経緯（猶予の PR）: 報告由来の report(done) は task を動かさなくなったので、同期（setStatus）が走る即時の終端 closed(done) で確かめる形へ変えた
  it('⭐ task ストアが投げても委譲は終わり、失敗は日誌に残る', async () => {
    const s = await setup(failingTasks);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push({
      type: 'closed',
      managerId: started.managerId,
      status: 'done',
      reason: '畳んだ',
    } as RunnerEvent);
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
  // 経緯（猶予の PR）: report(done) 直後の needs_decision は、猶予の後の見回りで作る形へ変えた。最後の1本が終わった後も、猶予の後の見回りで判断待ちへ倒れる
  it('⭐ 先に終わった1本は、走っている別の委譲がある間は task を判断待ちへ倒さない', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const a = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(a.managerId));
    await settle();
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
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

    // 最後の1本が終わると、猶予の後の見回りで判断待ちへ
    s.fake.push(report(a.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });
});

// 現状の動きの固定（pin）。期待は今の作りの出力から確かめた（仕様を先に書いたものではない）。
// 案 D（背景処理待ちで閉じた done では waiting の task を倒さない）の前後で、変わるもの・変わらないものを分けて置く。
describe('pin: ターン終わりの report(done) と終端の即時同期（案 D の前の動き）', () => {
  const needsDecisionLine = (lines: string[]): boolean =>
    lines.some((line) => line.includes('waiting から needs_decision'));

  // 反転済み（猶予の PR）: 直前の版の期待は「report(done) が 1 本来ると、waiting の task は即時に needs_decision へ倒れる（日誌にも残る）」。
  // 経緯: runner はターンが 1 回終わるたびに idle・背景待ち・完了を区別しない done を出し、manager_send で起こす委譲のターンごとに
  // waiting と needs_decision を往復していた。報告由来の done は task を動かさず、猶予（30 分）を過ぎて静かなままなら見回りが倒す（倒れ先は同じ）。
  it('反転済み: report(done) が 1 本来ても、猶予の内は waiting の task は倒れず、日誌にも出ない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(needsDecisionLine(await decisions(s.stores))).toBe(false);
  });

  it('waiting へ戻された task は、同じ委譲の別の report(done)（before=done）では倒れない', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00.000Z') };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    // 猶予の後の見回りが倒した後に、クローンが waiting へ戻す
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    await s.stores.tasks.setStatus('t-1', 'waiting', { by: 'clone', at: afterNow() });

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  // 反転済み（案 D）: 直前の版の期待は「awaitingBackground 付きの done でも needs_decision へ倒れる」。
  // 経緯: 背景処理の完了待ちで閉じたターンは委譲がまだ生きている（runner が自分で起き直す）のに、台帳が done を書くたび task が
  // waiting から needs_decision へ戻り、クローンが手で戻し直していた。背景待ちの done は task を倒さない（awaitingBackgroundSince の印）。
  // 背景待ちでない report(done) は、猶予の PR の後は猶予の内は倒さず、猶予を過ぎた見回りが倒す（上の 1 本目）。
  it('反転済み: awaitingBackground 付きの report(done) では waiting の task は倒れない', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push({
      ...report(started.managerId),
      awaitingBackground: { count: 1, breakdown: 'bash×1' },
    } as RunnerEvent);
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(needsDecisionLine(await decisions(s.stores))).toBe(false);
  });

  it.each([
    ['failed（report）', (id: string): RunnerEvent => report(id, 'failed')],
    [
      'lost（closed）',
      (id: string): RunnerEvent =>
        ({ type: 'closed', managerId: id, status: 'lost', reason: '器から消えた' }) as RunnerEvent,
    ],
    [
      'closed(done)',
      (id: string): RunnerEvent =>
        ({ type: 'closed', managerId: id, status: 'done', reason: '畳んだ' }) as RunnerEvent,
    ],
  ])('即時に倒す: %s は waiting の task を needs_decision へ倒す', async (_name, event) => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push(event(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('即時に倒す: stopped（abort）は waiting の task を needs_decision へ倒す', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    await s.pool.abort(started.managerId);
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });
});

// 現状の動きの固定（pin）その 2: 猶予（案 C の残り）を置く前の動き。期待は今の作りの出力から確かめた（仕様を先に書いたものではない）。
// 猶予の PR で、上の「pin: ターン終わりの report(done)…」の 1 本目（report(done) 即時）と、次の 2 本の期待を反転した（元のコメントは残し、経緯を足した。
// 反転後の期待は「報告由来の report(done) と、猶予内の restore では waiting の task を倒さない。倒れるのは猶予を過ぎた見回りだけ」）。
// 反転しないもの（即時に倒す stopped・failed・lost・closed(done)）は上の pin が持つ。
describe('pin: 猶予を置く前の動き（猶予の PR で反転したもの）', () => {
  const T0 = Date.parse('2026-10-29T00:00:00.000Z');
  const lineCount = (lines: string[], needle: string): number =>
    lines.filter((line) => line.includes(needle)).length;

  // 反転した: 直前の版の期待は「1 往復ごとに needs_decision と waiting を往復し、日誌の『waiting から needs_decision』は 2 件・『needs_decision から waiting』は 1 件」。
  // 猶予の後は、1 往復目の report(done) では倒れず、日誌の「waiting から needs_decision」は 0 件・「needs_decision から waiting」も 0 件になる
  it('(α) 反転済み: manager_send で起こした委譲のターンが何回終わっても、task は waiting のまま遷移しない', async () => {
    const clock = { at: T0 };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at += 60_000;
    await s.pool.send(started.managerId, '続きをお願い');
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at += 60_000;
    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    const lines = await decisions(s.stores);
    expect(lineCount(lines, 'waiting から needs_decision')).toBe(0);
    expect(lineCount(lines, 'needs_decision から waiting')).toBe(0);
  });

  // 反転した: 直前の版の期待は「たった今終わった done の委譲に結び付いた waiting の task も、restore が needs_decision へ倒す」。
  // 経緯: 猶予 0 のままだと、再起動のたびに（クローンが次の指示を送る前の）waiting が戻る。猶予（30 分）の内は倒さず、猶予を過ぎていれば倒す
  it('(iii) 反転済み: 起動時の restore は、たった今終わった done の委譲に結び付いた waiting の task を倒さない（猶予を過ぎれば倒す）', async () => {
    const clock = { at: T0 };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add({ ...task('t-1', 'waiting'), updatedAt: new Date(T0).toISOString() });
    await s.stores.jobs.putJob({
      ...ledgerJob('mgr-fresh', 'done', 't-1'),
      endedAt: new Date(T0).toISOString(),
    });

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at = T0 + GRACE_MS + 60_000;
    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });
});

// 新しい仕様を先に書いた試験（案 D）。上の pin と違い、実装の前は赤く、実装の後に緑になる。
// 背景処理の完了待ちで閉じたターンの report(done) は、委譲がまだ生きている印なので waiting の task を倒さない。
// 保留は Job.awaitingBackgroundSince が持ち、背景待ちでない report・closed・manager_send（running）で下り、6 時間で見回りが無視する。
describe('背景処理待ちで閉じた report(done) は waiting の task を倒さない（案 D）', () => {
  const HOUR = 60 * 60 * 1000;
  const T0 = Date.parse('2026-10-29T00:00:00.000Z');
  const needsDecisionLine = (lines: string[]): boolean =>
    lines.some((line) => line.includes('waiting から needs_decision'));
  const backgroundDone = (id: string): RunnerEvent =>
    ({
      ...report(id),
      awaitingBackground: { count: 1, breakdown: 'bash×1' },
    }) as RunnerEvent;
  const heldSince = async (s: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await s.stores.jobs.getJob(id))?.awaitingBackgroundSince;

  async function startBackgroundWaiting(clock: { at: number }) {
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(backgroundDone(started.managerId));
    await settle();
    return { s, id: started.managerId };
  }

  it('(a) 背景処理待ちの done では task は waiting のまま。日誌に「needs_decision にした」は出ず、印が立つ', async () => {
    const { s, id } = await startBackgroundWaiting({ at: T0 });
    expect((await s.stores.jobs.getJob(id))?.status).toBe('done');
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(needsDecisionLine(await decisions(s.stores))).toBe(false);
    expect(await heldSince(s, id)).toBe(new Date(T0).toISOString());
    // 終端へ入ったとは数えない（入れると見回りが拾う）
    expect((await s.stores.jobs.getJob(id))?.endedAt).toBeUndefined();
  });

  // 経緯（猶予の PR）: 背景待ちでない report(done) は、猶予の内は倒さず、猶予を過ぎた見回りが倒す形になった（印が下り endedAt が書かれることは変わらない）
  it('(b) その後、背景待ちでない report(done) が来ると、印は下り、endedAt が書かれ、猶予の後の見回りで倒れる', async () => {
    const clock = { at: T0 };
    const { s, id } = await startBackgroundWaiting(clock);

    s.fake.push(report(id));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    clock.at += GRACE_MS + 60_000;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    expect(needsDecisionLine(await decisions(s.stores))).toBe(true);
    expect(await heldSince(s, id)).toBeUndefined();
    expect((await s.stores.jobs.getJob(id))?.endedAt).toBeDefined();
  });

  // 印の時刻は報告のたびに進める: 上限は「runner からの便りが途絶えてから」の長さで、報告が来続ける委譲は生きている
  it('(b2) 背景待ちの done がもう 1 本来ても、まだ倒れず、印の時刻は最新の報告へ進む', async () => {
    const clock = { at: T0 };
    const { s, id } = await startBackgroundWaiting(clock);

    clock.at += HOUR;
    s.fake.push(backgroundDone(id));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(await heldSince(s, id)).toBe(new Date(T0 + HOUR).toISOString());
  });

  it('(c) manager_send（running を書く）で印が下り、task は waiting のまま・日誌に倒した行は出ない', async () => {
    const { s, id } = await startBackgroundWaiting({ at: T0 });

    await s.pool.send(id, '続きをお願い');
    await settle();
    expect((await s.stores.jobs.getJob(id))?.status).toBe('running');
    expect(await heldSince(s, id)).toBeUndefined();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(needsDecisionLine(await decisions(s.stores))).toBe(false);
  });

  it('(d) closed(done) で印が下り、task は倒れる', async () => {
    const { s, id } = await startBackgroundWaiting({ at: T0 });

    s.fake.push({ type: 'closed', managerId: id, status: 'done', reason: '畳んだ' } as RunnerEvent);
    await settle();
    expect(await heldSince(s, id)).toBeUndefined();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('(d2) closed(lost) でも印が下りる', async () => {
    const { s, id } = await startBackgroundWaiting({ at: T0 });

    s.fake.push({
      type: 'closed',
      managerId: id,
      status: 'lost',
      reason: '器から消えた',
    } as RunnerEvent);
    await settle();
    expect(await heldSince(s, id)).toBeUndefined();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('(e) 6 時間を過ぎたら見回り（restore）が倒す。上限の内は倒さない', async () => {
    const clock = { at: T0 };
    const { s } = await startBackgroundWaiting(clock);

    clock.at = T0 + 6 * HOUR - 60_000;
    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at = T0 + 6 * HOUR + 60_000;
    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    expect((await decisions(s.stores)).some((line) => line.includes('起動時の直し'))).toBe(true);
  });

  it('(e2) 上限を過ぎた後に manager_send が来ても、task は waiting へ戻る（上限を過ぎた印は読まない）', async () => {
    const clock = { at: T0 };
    const { s, id } = await startBackgroundWaiting(clock);
    clock.at = T0 + 6 * HOUR + 60_000;
    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');

    await s.pool.send(id, '続きをお願い');
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
  });

  it('(f) 印の立った委譲の task は、endedAt が在っても見回り（restore）が倒さない（active 扱い）', async () => {
    const clock = { at: T0 };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1', 'waiting'));
    await s.stores.jobs.putJob({
      ...ledgerJob('mgr-bg', 'done', 't-1'),
      awaitingBackgroundSince: new Date(T0 - 60_000).toISOString(),
    });

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect((await decisions(s.stores)).some((line) => line.includes('起動時の直し'))).toBe(false);
  });

  // 経緯（猶予の PR）: 時計を猶予（30 分）の後へ進めた（台帳の endedAt は T0。猶予の内なら倒さない）
  it('(f2) 印の無い done の委譲の task は、猶予を過ぎていれば今までどおり見回りが倒す', async () => {
    const clock = { at: T0 + GRACE_MS + 60_000 };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1', 'waiting'));
    await s.stores.jobs.putJob(ledgerJob('mgr-bg', 'done', 't-1'));

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('(f3) 印が上限を過ぎた台帳の行（endedAt なし）は、印の時刻を終端の時刻として見回りが倒す', async () => {
    const clock = { at: T0 + 7 * HOUR };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add({ ...task('t-1', 'waiting'), updatedAt: new Date(T0).toISOString() });
    const held = ledgerJob('mgr-bg', 'done', 't-1');
    delete held.endedAt;
    await s.stores.jobs.putJob({ ...held, awaitingBackgroundSince: new Date(T0).toISOString() });

    await s.pool.restore();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  it('印は台帳に残り、別のプール（再起動）でも読み戻される', async () => {
    const { s, id } = await startBackgroundWaiting({ at: T0 });
    const after = await setup(undefined, s.stores, () => T0 + HOUR);
    expect(await heldSince(after, id)).toBe(new Date(T0).toISOString());
    expect(await taskStatus(after.stores, 't-1')).toBe('waiting');
  });
});

// 新しい仕様を先に書いた試験（案 C の残り）。上の pin と違い、実装の前は赤く、実装の後に緑になる（仕様から書いたもので、今の作りの出力から確かめたものではない）。
// 報告由来の report(done)（ターンの終わり。背景待ちでない）は task を即時には倒さず、猶予（30 分）を過ぎて静かなままなら見回り（repairStrandedTasks）が倒す。
// 即時に倒すのは stopped・failed・lost・closed(done)（セッションが畳まれた）で、今までどおり。
describe('報告由来の report(done) は猶予の内は waiting の task を倒さず、猶予を過ぎた見回りが倒す（案 C の残り）', () => {
  const MIN = 60_000;
  // 猶予は 30 分（実装の定数の値をここへ書き写して固定する: 値が動いたら試験が知らせる）
  const GRACE = 30 * MIN;
  const T0 = Date.parse('2026-10-29T00:00:00.000Z');
  const needsDecisionLine = (lines: string[]): boolean =>
    lines.some((line) => line.includes('waiting から needs_decision'));
  const backToWaitingLine = (lines: string[]): boolean =>
    lines.some((line) => line.includes('needs_decision から waiting'));
  const backgroundDone = (id: string): RunnerEvent =>
    ({
      ...report(id),
      awaitingBackground: { count: 1, breakdown: 'bash×1' },
    }) as RunnerEvent;

  async function startAndReport(clock: { at: number }) {
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(report(started.managerId));
    await settle();
    return { s, id: started.managerId };
  }

  it('(a) 猶予内の report(done) で task は waiting のまま。日誌に「needs_decision にした」は出ず、endedAt は書かれる', async () => {
    const { s, id } = await startAndReport({ at: T0 });
    expect((await s.stores.jobs.getJob(id))?.status).toBe('done');
    expect((await s.stores.jobs.getJob(id))?.endedAt).toBe(new Date(T0).toISOString());
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    expect(needsDecisionLine(await decisions(s.stores))).toBe(false);
  });

  it('(b) 猶予を過ぎて repairStrandedTasks を呼ぶと needs_decision。猶予の内では何度呼んでも倒さず、倒した後に何度呼んでも日誌は増えない', async () => {
    const clock = { at: T0 };
    const { s } = await startAndReport(clock);

    clock.at = T0 + GRACE - MIN;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at = T0 + GRACE + MIN;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    const count = (await decisions(s.stores)).filter((l) =>
      l.includes('waiting から needs_decision'),
    ).length;
    expect(count).toBe(1);

    await s.pool.repairStrandedTasks();
    expect(
      (await decisions(s.stores)).filter((l) => l.includes('waiting から needs_decision')),
    ).toHaveLength(1);
  });

  it('(b2) 猶予を過ぎる前にクローンが task を動かしていたら、見回りは倒さない', async () => {
    const clock = { at: T0 };
    const { s } = await startAndReport(clock);
    await s.stores.tasks.setStatus('t-1', 'queued', {
      by: 'clone',
      at: new Date(T0 + 5 * MIN).toISOString(),
    });

    clock.at = T0 + GRACE + MIN;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('queued');
  });

  it('(c) 猶予内に manager_send が来ると task は waiting のまま。ターンを何回往復しても、日誌に遷移（倒す・戻す）が出ない', async () => {
    const clock = { at: T0 };
    const { s, id } = await startAndReport(clock);

    for (let turn = 0; turn < 3; turn += 1) {
      clock.at += 5 * MIN;
      await s.pool.send(id, '続きをお願い');
      await settle();
      expect((await s.stores.jobs.getJob(id))?.status).toBe('running');
      expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
      expect((await s.stores.jobs.getJob(id))?.endedAt).toBeUndefined();

      clock.at += 5 * MIN;
      s.fake.push(report(id));
      await settle();
      expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
    }
    const lines = (await decisions(s.stores)).filter((line) => line.includes('task t-1'));
    expect(needsDecisionLine(lines)).toBe(false);
    expect(backToWaitingLine(lines)).toBe(false);
    // 起こした直後の queued → waiting の 1 件だけ
    expect(lines).toHaveLength(1);
  });

  it('(d) 背景待ちの保留中は猶予を過ぎても倒さず、保留が下りた後の猶予で倒れる', async () => {
    const clock = { at: T0 };
    const s = await setup(undefined, undefined, () => clock.at);
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });
    s.fake.push(backgroundDone(started.managerId));
    await settle();

    // 猶予の 2 倍が過ぎても、保留（6 時間の内）は倒さない
    clock.at = T0 + 2 * GRACE;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    // 保留が下りる（背景待ちでない報告）。ここから猶予を数える
    const releasedAt = clock.at;
    s.fake.push(report(started.managerId));
    await settle();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at = releasedAt + GRACE - MIN;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('waiting');

    clock.at = releasedAt + GRACE + MIN;
    await s.pool.repairStrandedTasks();
    expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
  });

  describe('(e) 猶予 0: stopped・failed・lost・closed(done) は今までどおり即時に倒れる', () => {
    it.each([
      ['failed（report）', (id: string): RunnerEvent => report(id, 'failed')],
      [
        'lost（closed）',
        (id: string): RunnerEvent =>
          ({
            type: 'closed',
            managerId: id,
            status: 'lost',
            reason: '器から消えた',
          }) as RunnerEvent,
      ],
      [
        'closed(done)',
        (id: string): RunnerEvent =>
          ({ type: 'closed', managerId: id, status: 'done', reason: '畳んだ' }) as RunnerEvent,
      ],
    ])('%s', async (_name, event) => {
      const clock = { at: T0 };
      const s = await setup(undefined, undefined, () => clock.at);
      await s.stores.tasks.add(task('t-1'));
      const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

      s.fake.push(event(started.managerId));
      await settle();
      expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    });

    it('stopped（abort）', async () => {
      const clock = { at: T0 };
      const s = await setup(undefined, undefined, () => clock.at);
      await s.stores.tasks.add(task('t-1'));
      const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

      await s.pool.abort(started.managerId);
      await settle();
      expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
    });

    it.each(['failed', 'lost', 'stopped'] as const)(
      '見回りも、台帳が %s の委譲の task は endedAt の直後でも倒す（同期が落ちた回の直し）',
      async (status) => {
        const clock = { at: T0 };
        const s = await setup(undefined, undefined, () => clock.at);
        await s.stores.tasks.add({
          ...task('t-1', 'waiting'),
          updatedAt: new Date(T0).toISOString(),
        });
        await s.stores.jobs.putJob({
          ...ledgerJob('mgr-x', status, 't-1'),
          endedAt: new Date(T0).toISOString(),
        });

        await s.pool.repairStrandedTasks();
        expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
      },
    );
  });

  describe('(f) 起動時の restore も同じ猶予を使う', () => {
    async function startedLedger(clock: { at: number }) {
      const s = await setup(undefined, undefined, () => clock.at);
      await s.stores.tasks.add({
        ...task('t-1', 'waiting'),
        updatedAt: new Date(T0).toISOString(),
      });
      await s.stores.jobs.putJob({
        ...ledgerJob('mgr-fresh', 'done', 't-1'),
        endedAt: new Date(T0).toISOString(),
      });
      return s;
    }

    it('猶予内の done は倒さない（再起動のたびに戻らない）', async () => {
      const clock = { at: T0 + 10 * MIN };
      const s = await startedLedger(clock);
      await s.pool.restore();
      await s.pool.restore();
      expect(await taskStatus(s.stores, 't-1')).toBe('waiting');
      expect((await decisions(s.stores)).some((line) => line.includes('起動時の直し'))).toBe(false);
    });

    it('猶予を過ぎていれば倒す', async () => {
      const clock = { at: T0 + GRACE + MIN };
      const s = await startedLedger(clock);
      await s.pool.restore();
      expect(await taskStatus(s.stores, 't-1')).toBe('needs_decision');
      expect((await decisions(s.stores)).some((line) => line.includes('起動時の直し'))).toBe(true);
    });
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
      describeManagerOrigin({ kind: 'job', conversationId: 'conv-1', taskId: 't-1' }),
    ).toContain('結び付いた task: t-1');
    expect(describeManagerOrigin({ kind: 'job', conversationId: null, taskId: 't-1' })).toContain(
      '結び付いた task: t-1',
    );
  });

  it('⭐ 起点の会話が無くても taskId があれば、「task_say で書く」案内を出し、task 無しの手順（task_list で探す・task_add で足す）は出さない', () => {
    const none = describeManagerOrigin({ kind: 'job', conversationId: null, taskId: 't-1' });
    expect(none).toContain('結び付いた task へ `task_say` で書く');
    expect(none).toContain('task_set_status で done にする');
    expect(none).not.toContain('task_list で探し');
    const conv = describeManagerOrigin({ kind: 'job', conversationId: 'conv-1', taskId: 't-1' });
    expect(conv).toContain('結び付いた task へ `task_say` で書く');
    expect(conv).not.toContain('task_list で探し');
  });

  // 経緯: 以前は起点の会話の無い委譲にだけ別の手順（ORIGIN_NONE_GUIDE「task_add で足すと新しい会話ができる」）を出し、この試験はその違いを固定していた。
  // task_add が宛先の会話を器で決める（起点の会話、無ければ新しい会話）ので手順は同じになり、#5469 の残りとして案内を1本にまとめた。期待を「同じ案内を出す」へ反転した
  it('⭐ taskId が無い委譲は、起点の会話の有無によらず同じ手順（task_list で探す・無ければ task_add で足す）を出す', () => {
    const conv = describeManagerOrigin({ kind: 'job', conversationId: 'conv-1' });
    const none = describeManagerOrigin({ kind: 'job', conversationId: null });
    expect(conv).toContain(ORIGIN_NO_TASK_GUIDE);
    expect(none).toContain(ORIGIN_NO_TASK_GUIDE);
    expect(none).toContain('起点の会話: 無し');
    expect(none).not.toContain('task_add で足すと新しい会話ができる');
  });

  // manager_list の行（`ORIGIN_HINT_NO_TASK_FULL`）は起点の会話があるときにしか案内を出さないので「この会話を起点にした」のまま。手順の語（task_list で探して task_say、無ければ task_add）を揃える
  it('⭐ taskId が無い起点の会話の案内は、manager_list の行と同じ手順（task_list で探して task_say、無ければ task_add）', () => {
    const text = describeManagerOrigin({ kind: 'job', conversationId: 'conv-1' });
    expect(text).toContain(
      '人間へ知らせるなら、この委譲の起点の会話の task を task_list で探して `task_say` で書く。無ければ task_add で足す',
    );
    expect(text).not.toContain('結び付いた task〔');
  });

  it('結び付いていなければ、行そのものを出さない', () => {
    expect(describeManagerOrigin({ kind: 'job', conversationId: 'conv-1' })).not.toContain(
      '結び付いた task:',
    );
    expect(describeManagerOrigin({ kind: 'job', conversationId: null })).not.toContain(
      '結び付いた task:',
    );
  });

  it('台帳に無い・読めない委譲は「分からない」と名乗り、「無し」に畳まない', () => {
    expect(describeManagerOrigin({ kind: 'missing', conversationId: null })).toContain(
      '起点の会話: 分からない',
    );
    expect(
      describeManagerOrigin({ kind: 'unreadable', conversationId: null, reason: 'x' }),
    ).not.toContain('起点の会話: 無し');
  });
});
