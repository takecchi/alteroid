import { describe, expect, it } from 'vitest';

import { describeManagerOrigin } from './clone.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Task } from './schema.js';
import type { Stores } from './store.js';
import { taskStatusForJob } from './task.js';
import { createMemoryStores } from './testing.js';
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

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
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
      return [];
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

async function setup() {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  await pool.restore();
  return { pool, fake, stores };
}

function report(managerId: string, status: 'done' | 'failed' = 'done'): RunnerEvent {
  return { type: 'report', managerId, text: '終わった', status } as RunnerEvent;
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
    expect((await s.stores.tasks.get('t-1'))?.status).toBe('waiting');

    s.fake.push(report(started.managerId));
    await settle();
    expect((await s.stores.tasks.get('t-1'))?.status).toBe('needs_decision');
    expect((await s.stores.tasks.get('t-1'))?.closedAt).toBeUndefined();
  });

  it('失敗で終わった委譲の task も判断待ちに戻る', async () => {
    const s = await setup();
    await s.stores.tasks.add(task('t-1'));
    const started = await s.pool.start({ request: '調べる', taskId: 't-1' });

    s.fake.push(report(started.managerId, 'failed'));
    await settle();
    expect((await s.stores.tasks.get('t-1'))?.status).toBe('needs_decision');
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
    expect((await s.stores.tasks.get('t-1'))?.status).toBe('queued');
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
    expect((await s.stores.tasks.get('t-1'))?.status).toBe('queued');
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

  it('結び付いていなければ、行そのものを出さない', () => {
    expect(describeManagerOrigin({ kind: 'conversation', conversationId: 'conv-1' })).not.toContain(
      'task',
    );
    expect(describeManagerOrigin({ kind: 'none' })).not.toContain('結び付いた task');
  });
});
