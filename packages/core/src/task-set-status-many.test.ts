import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CommitmentOrigin, Task } from './schema.js';
import { commitmentOriginSchema } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, createCloneTools } from './tools.js';

// `task_set_status_many`: 開いている Task を絞り込みで選び、まとめて done / cancelled にする（台帳の `commitment_close_many` の置き換え。#5923）。

function runner(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'task_set_status_many');
  expect(found, 'task_set_status_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

const BASE_AT = Date.parse('2026-01-01T00:00:00.000Z');

function taskAt(index: number, origin: CommitmentOrigin, overrides: Partial<Task> = {}): Task {
  const at = new Date(BASE_AT + index * 1000).toISOString();
  return {
    id: randomUUID(),
    createdAt: at,
    updatedAt: at,
    status: 'queued',
    origin,
    title: `仕事 ${index}`,
    body: `本文 ${index}`,
    ...overrides,
  };
}

async function addAll(stores: Stores, tasks: readonly Task[]): Promise<void> {
  for (const task of tasks) await stores.tasks.add(task);
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

describe('task_set_status_many の登録', () => {
  it('道具の名簿に在り、台帳の書き込みの道具は名簿に無い', () => {
    expect(CLONE_TOOL_NAMES).toContain('task_set_status_many');
    expect(CLONE_TOOL_NAMES).toContain('commitment_list');
    for (const removed of [
      'commitment_open',
      'commitment_close',
      'commitment_reopen',
      'commitment_edit',
      'commitment_close_many',
    ]) {
      expect(CLONE_TOOL_NAMES as readonly string[], removed).not.toContain(removed);
    }
  });

  it('createCloneTools は台帳の書き込みの道具を登録しない', () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const names = tools.map((entry) => entry.name);
    for (const removed of [
      'commitment_open',
      'commitment_close',
      'commitment_reopen',
      'commitment_edit',
      'commitment_close_many',
    ]) {
      expect(names, removed).not.toContain(removed);
    }
    expect(names).toContain('commitment_list');
    expect(names).toContain('task_set_status_many');
  });
});

describe('task_set_status_many の検証（describeCloseManyViolation の作法）', () => {
  it('origin に全部の起点を並べた呼びは断り、1件も変えない', async () => {
    const stores = createMemoryStores();
    const tasks = [
      taskAt(0, 'human'),
      taskAt(1, 'manager'),
      taskAt(2, 'external'),
      taskAt(3, 'self'),
    ];
    await addAll(stores, tasks);

    const reply = await runner(stores)({
      origin: commitmentOriginSchema.options,
      status: 'done',
      reason: '全部片付けたつもり',
      dryRun: false,
    });

    expect(reply).toContain('全部');
    expect(reply).toContain('1件も閉じていない');
    expect((await stores.tasks.list()).entries).toHaveLength(4);
  });

  it.each([
    ['空の origin', { origin: [] }],
    ['空の source', { origin: ['self'], source: [] }],
    ['空文字の q', { origin: ['self'], q: '' }],
    ['空白だけの reason', { origin: ['self'], reason: '   ' }],
    ['NUL だけの reason', { origin: ['self'], reason: '\u0000' }],
    ['空の reason', { origin: ['self'], reason: '' }],
    ['limit 0', { origin: ['self'], limit: 0 }],
    ['limit 2001', { origin: ['self'], limit: 2001 }],
    ['時差の無い until', { origin: ['self'], until: '2026-02-01T00:00:00' }],
    ['読めない until', { origin: ['self'], until: 'きのう' }],
  ])('%s は断り、当たる Task があっても1件も変えない', async (_label, args) => {
    const stores = createMemoryStores();
    const task = taskAt(0, 'self');
    await addAll(stores, [task]);

    const reply = await runner(stores)({
      status: 'done',
      reason: '理由',
      dryRun: false,
      ...args,
    });

    expect(reply.length).toBeGreaterThan(0);
    expect((await stores.tasks.get(task.id))?.status).toBe('queued');
  });

  it('status に開いている状態（queued）は取らない。閉じる状態だけ', async () => {
    const stores = createMemoryStores();
    const task = taskAt(0, 'self');
    await addAll(stores, [task]);
    const call = runner(stores);
    await call({ origin: ['self'], status: 'queued', reason: 'r', dryRun: false }).catch(
      () => undefined,
    );
    expect((await stores.tasks.get(task.id))?.status).toBe('queued');
    expect((await stores.tasks.get(task.id))?.closedAt).toBeUndefined();
  });
});

describe('task_set_status_many の振る舞い', () => {
  it('dryRun を省くと1件も変えず、当たる件数を言う', async () => {
    const stores = createMemoryStores();
    const task = taskAt(0, 'external');
    await addAll(stores, [task]);

    const reply = await runner(stores)({ origin: ['external'], status: 'done', reason: '試算' });

    expect(reply).toContain('試算');
    expect((await stores.tasks.get(task.id))?.status).toBe('queued');
    expect(await decisionTexts(stores)).toEqual([]);
  });

  it('dryRun: false は当たった Task だけを指定の状態にし、理由・主体を残す。他の起点は無傷', async () => {
    const stores = createMemoryStores();
    const target = taskAt(0, 'external');
    const other = taskAt(1, 'human');
    await addAll(stores, [target, other]);

    await runner(stores)({
      origin: ['external'],
      status: 'cancelled',
      reason: 'やらないと決めた',
      dryRun: false,
    });

    const closed = await stores.tasks.get(target.id);
    expect(closed?.status).toBe('cancelled');
    expect(closed?.closedReason).toBe('やらないと決めた');
    expect(closed?.closedBy).toBe('clone');
    expect((await stores.tasks.get(other.id))?.status).toBe('queued');
  });

  it('source は完全一致。q は title / body / source への大小無視の部分一致', async () => {
    const stores = createMemoryStores();
    const exact = taskAt(0, 'external', { source: 'token-pool' });
    const near = taskAt(1, 'external', { source: 'token-pool-2' });
    const hitsTitle = taskAt(2, 'self', { title: 'NeeDLE-title' });
    const hitsBody = taskAt(3, 'self', { body: 'ここに needle がある' });
    const misses = taskAt(4, 'self');
    await addAll(stores, [exact, near, hitsTitle, hitsBody, misses]);

    await runner(stores)({
      origin: ['external'],
      source: ['token-pool'],
      status: 'done',
      reason: 'source',
      dryRun: false,
    });
    await runner(stores)({
      origin: ['self'],
      q: 'NEEDLE',
      status: 'done',
      reason: 'q',
      dryRun: false,
    });

    expect((await stores.tasks.get(exact.id))?.status).toBe('done');
    expect((await stores.tasks.get(near.id))?.status).toBe('queued');
    expect((await stores.tasks.get(hitsTitle.id))?.status).toBe('done');
    expect((await stores.tasks.get(hitsBody.id))?.status).toBe('done');
    expect((await stores.tasks.get(misses.id))?.status).toBe('queued');
  });

  it('until は createdAt が境界ちょうどの Task を含み、後のものを含まない', async () => {
    const stores = createMemoryStores();
    const boundary = '2026-02-01T00:00:00.000Z';
    const atBoundary = taskAt(0, 'external', { createdAt: boundary });
    const after = taskAt(1, 'external', { createdAt: '2026-02-01T00:00:00.001Z' });
    await addAll(stores, [atBoundary, after]);

    await runner(stores)({
      origin: ['external'],
      until: boundary,
      status: 'done',
      reason: 'until',
      dryRun: false,
    });

    expect((await stores.tasks.get(atBoundary.id))?.status).toBe('done');
    expect((await stores.tasks.get(after.id))?.status).toBe('queued');
  });

  it('limit は古い側から limit 件だけを変え、残件数を言う', async () => {
    const stores = createMemoryStores();
    const tasks = [0, 1, 2, 3, 4].map((i) => taskAt(i, 'external'));
    await addAll(stores, tasks);

    const reply = await runner(stores)({
      origin: ['external'],
      limit: 2,
      status: 'done',
      reason: '上限',
      dryRun: false,
    });

    expect((await stores.tasks.get(tasks[0]!.id))?.status).toBe('done');
    expect((await stores.tasks.get(tasks[1]!.id))?.status).toBe('done');
    for (const task of tasks.slice(2))
      expect((await stores.tasks.get(task.id))?.status).toBe('queued');
    expect(reply).toContain('残り 3 件');
  });

  it('既に閉じている Task は当たらず、元の理由も無傷', async () => {
    const stores = createMemoryStores();
    const task = taskAt(0, 'external');
    await addAll(stores, [task]);
    await stores.tasks.setStatus(task.id, 'done', {
      reason: '先に閉じた',
      by: 'human',
      at: new Date().toISOString(),
    });

    await runner(stores)({
      origin: ['external'],
      status: 'cancelled',
      reason: '後から',
      dryRun: false,
    });

    const after = await stores.tasks.get(task.id);
    expect(after?.status).toBe('done');
    expect(after?.closedReason).toBe('先に閉じた');
  });

  it('0件のとき、1件も変えていないと言い、台帳に未了が無い旨ではなく task の旨を言う', async () => {
    const stores = createMemoryStores();
    const reply = await runner(stores)({ origin: ['external'], status: 'done', reason: 'r' });
    expect(reply).toContain('1件も閉じていない');
    expect(reply).toContain('task');
    expect(reply).not.toContain('台帳');
  });

  it('250件を閉じると、変えた id が全部・過不足なく複数件の日誌に残る', async () => {
    const stores = createMemoryStores();
    const tasks = Array.from({ length: 250 }, (_, i) => taskAt(i, 'external'));
    await addAll(stores, tasks);

    await runner(stores)({ origin: ['external'], status: 'done', reason: '一括', dryRun: false });

    expect((await stores.tasks.list()).entries).toHaveLength(0);
    const texts = await decisionTexts(stores);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    const written = new Set(
      texts.join(' ').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
    );
    expect(written).toEqual(new Set(tasks.map((task) => task.id)));
  });

  it('塊の途中で日誌が落ちると投げ、最初の塊は日誌に残る', async () => {
    const stores = createMemoryStores();
    const tasks = Array.from({ length: 250 }, (_, i) => taskAt(i, 'external'));
    await addAll(stores, tasks);
    let calls = 0;
    const flaky: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: (entry) => {
          calls += 1;
          if (calls >= 2) return Promise.reject(new Error('日誌が落ちた（テスト用）'));
          return stores.journal.append(entry);
        },
      },
    };

    await expect(
      runner(flaky)({ origin: ['external'], status: 'done', reason: '途中', dryRun: false }),
    ).rejects.toThrow();
    expect(await decisionTexts(stores)).toHaveLength(1);
  });
});
