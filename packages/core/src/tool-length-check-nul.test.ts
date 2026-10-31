import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return {
    stores,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

const AT = '2026-10-06T00:00:00.000Z';
const NUL_ONLY = ['\u0000', '\u0000\u0000'];

function seedTask(id: string, origin: 'self' | 'external') {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status: 'queued' as const,
    origin,
    title: 'タイトル',
    body: '本文',
  };
}

describe('NUL だけの理由・本文を、道具が空として残す', () => {
  it('task_set_status: reason が NUL だけなら、空の closedReason で閉じない', async () => {
    const h = harness();
    await h.stores.tasks.add(seedTask('t1', 'self'));
    const out = await h.call('task_set_status', { taskId: 't1', status: 'done', reason: '\u0000' });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.tasks.get('t1'))?.closedReason).toBeUndefined();
  });

  it('task_set_status_many: reason が NUL だけなら、空の closedReason で閉じない', async () => {
    const h = harness();
    await h.stores.tasks.add(seedTask('t2', 'external'));
    const out = await h.call('task_set_status_many', {
      origin: ['external'],
      until: '2026-12-31T00:00:00.000Z',
      status: 'done',
      reason: '\u0000',
      dryRun: false,
    });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.tasks.get('t2'))?.closedReason).toBeUndefined();
  });

  it('approval_withdraw: reason が NUL だけなら、空の withdrawnReason で取り下げない', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({ id: 'ap1', createdAt: AT, question: '質問' });
    const out = await h.call('approval_withdraw', { id: 'ap1', reason: '\u0000' });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.jobs.getApproval('ap1'))?.withdrawnReason).toBeUndefined();
  });

  it('task_say: text が NUL だけなら、空の発言を日誌へ残さない', async () => {
    const h = harness();
    const out = await h.call('task_say', { taskId: 't1', text: '\u0000' });
    expect(out).toContain('text は使えない');
    const rows = await h.stores.journal.list({ types: ['exchange'] });
    expect(rows).toEqual([]);
  });

  it.each(NUL_ONLY)('inbox_remove_many: reason %j は断る', async (reason) => {
    const h = harness();
    const out = await h.call('inbox_remove_many', {
      types: ['manager_message'],
      reason,
      dryRun: false,
    });
    expect(out).toContain('reason は使えない');
  });

  it.each(NUL_ONLY)('archive_remove_many: summary %j は断る', async (summary) => {
    const h = harness();
    const out = await h.call('archive_remove_many', {
      sessionIds: ['s1'],
      summary,
      dryRun: false,
    });
    expect(out).toContain('summary は使えない');
  });
});

describe('NUL が混じっても中身が残る値は今までどおり通る', () => {
  it('task_set_status: reason "a\\0b" は閉じ、NUL を落とした値が残る', async () => {
    const h = harness();
    await h.stores.tasks.add(seedTask('t1', 'self'));
    const out = await h.call('task_set_status', {
      taskId: 't1',
      status: 'done',
      reason: 'a\u0000b',
    });
    expect(out).not.toContain('は使えない');
    expect((await h.stores.tasks.get('t1'))?.closedReason).toBe('ab');
  });

  it('task_set_status_many: reason は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('task_set_status_many', {
      origin: ['external'],
      until: '2026-12-31T00:00:00.000Z',
      status: 'done',
      reason: 'a\u0000',
    });
    expect(out).not.toContain('reason は使えない');
  });

  it('approval_withdraw: reason は取り下げに通り、NUL を落とした値が残る', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({ id: 'ap1', createdAt: AT, question: '質問' });
    const out = await h.call('approval_withdraw', { id: 'ap1', reason: '\u0000x' });
    expect(out).not.toContain('reason は使えない');
    expect((await h.stores.jobs.getApproval('ap1'))?.withdrawnReason).toBe('x');
  });

  it('task_say: text は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('task_say', { taskId: 't1', text: 'こん\u0000にちは' });
    expect(out).not.toContain('text は使えない');
  });

  it('inbox_remove_many: reason は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('inbox_remove_many', {
      types: ['manager_message'],
      reason: 'a\u0000',
    });
    expect(out).not.toContain('reason は使えない');
  });

  it('archive_remove_many: summary は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('archive_remove_many', { sessionIds: ['s1'], summary: '\u0000a' });
    expect(out).not.toContain('summary は使えない');
  });
});
