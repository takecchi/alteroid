import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { JournalEntry, Task } from './schema.js';
import { journalEntrySchema } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// クローンの task の道具は、task を指す宛先（`target: { kind: 'task', id }`）付きの `decision` を日誌へ積む。
// 宛先が無いと、Web の SSE が task の一覧を取り直す手がかりを持てない。

function runner(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return async (name: string, args: Record<string, unknown>) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`道具 ${name} が無い`);
    const result = await found.handler(args as never, {} as never);
    return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

function seed(index: number): Task {
  const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString();
  return {
    id: randomUUID(),
    createdAt: at,
    updatedAt: at,
    status: 'queued',
    origin: 'external',
    title: `仕事 ${index}`,
    body: `本文 ${index}`,
  };
}

async function lastDecision(stores: Stores): Promise<Extract<JournalEntry, { type: 'decision' }>> {
  const entries = await stores.journal.list({ types: ['decision'] });
  const last = entries.at(-1);
  if (last?.type !== 'decision') throw new Error('decision が無い');
  return last;
}

describe('クローンの task の道具が書く decision の宛先', () => {
  it('task_add: 足した task の id を指す', async () => {
    const stores = createMemoryStores();
    await runner(stores)('task_add', { title: '足す件', body: '本文' });
    const [task] = (await stores.tasks.list({ includeClosed: true })).entries;
    expect((await lastDecision(stores)).target).toEqual({ kind: 'task', id: task!.id });
  });

  it('task_set_status: 閉じる・開き直すのどちらも、その task の id を指す', async () => {
    const stores = createMemoryStores();
    const task = seed(0);
    await stores.tasks.add(task);
    const run = runner(stores);

    await run('task_set_status', { taskId: task.id, status: 'done', reason: '終えた' });
    expect((await lastDecision(stores)).target).toEqual({ kind: 'task', id: task.id });

    await run('task_set_status', { taskId: task.id, status: 'queued' });
    expect((await lastDecision(stores)).target).toEqual({ kind: 'task', id: task.id });
  });

  it('task_move・task_keep: その task の id を指す', async () => {
    const stores = createMemoryStores();
    const task = seed(0);
    await stores.tasks.add(task);
    await stores.tasks.add(seed(1));
    const run = runner(stores);

    await run('task_move', { taskId: task.id, to: 'back' });
    expect((await lastDecision(stores)).target).toEqual({ kind: 'task', id: task.id });

    await run('task_keep', { taskId: task.id, keep: true });
    expect((await lastDecision(stores)).target).toEqual({ kind: 'task', id: task.id });
  });

  it('task_set_status_many: 宛先は task の種類で、id は持たない（一覧だけを指す）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(seed(0));
    await runner(stores)('task_set_status_many', {
      origin: ['external'],
      status: 'cancelled',
      reason: 'やらない',
      dryRun: false,
    });
    expect((await lastDecision(stores)).target).toEqual({ kind: 'task' });
  });

  it('宛先の無い古い task の decision も、今までどおり読める', () => {
    const parsed = journalEntrySchema.parse({
      type: 'decision',
      id: 'old',
      at: '2026-01-01T00:00:00.000Z',
      decision: 'task を足した（t-1）: 題',
      grounds: '自分で task_add した',
    });
    expect(parsed.type === 'decision' && parsed.target).toBeUndefined();
  });

  it('宛先は task の種類と practice の種類を受ける', () => {
    const base = {
      type: 'decision',
      id: 'd',
      at: '2026-01-01T00:00:00.000Z',
      decision: 'x',
      grounds: 'y',
    };
    for (const target of [
      { kind: 'task', id: 't-1' },
      { kind: 'task' },
      { kind: 'practice', slug: 'daily' },
    ]) {
      expect(journalEntrySchema.safeParse({ ...base, target }).success).toBe(true);
    }
    expect(journalEntrySchema.safeParse({ ...base, target: { kind: 'other' } }).success).toBe(
      false,
    );
  });
});
