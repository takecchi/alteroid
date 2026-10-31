import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const sent: { managerId: string; message: string }[] = [];
  const managers = {
    async send(managerId: string, message: string) {
      sent.push({ managerId, message });
      return { outcome: 'answered' as const, detail: '回答した。' };
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers,
  });
  return {
    stores,
    sent,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

const AT = '2026-10-07T00:00:00.000Z';

const seedTask = {
  id: 't1',
  createdAt: AT,
  updatedAt: AT,
  status: 'queued' as const,
  origin: 'self' as const,
  title: 'タイトル',
  body: '本文',
};

describe('task_set_status の reason は HTTP と同じく空白だけを断る（#3544。commitment_close の置き換え）', () => {
  it.each([' ', '   ', '\t\n', '　', ' \u0000 ', '', '\u0000'])(
    'reason %j は断り、閉じない',
    async (reason) => {
      const h = harness();
      await h.stores.tasks.add(seedTask);
      const out = await h.call('task_set_status', { taskId: 't1', status: 'done', reason });
      expect(out).toContain('reason は使えない');
      expect((await h.stores.tasks.get('t1'))?.closedAt).toBeUndefined();
      const rows = await h.stores.journal.list({ types: ['decision'] });
      expect(rows.some((row) => JSON.stringify(row).includes('task の状態を変えた'))).toBe(false);
    },
  );

  it('実のある reason は従来どおり閉じられ、値は trim されない', async () => {
    const h = harness();
    await h.stores.tasks.add(seedTask);
    const out = await h.call('task_set_status', {
      taskId: 't1',
      status: 'done',
      reason: ' 済んだ ',
    });
    expect(out).not.toContain('reason は使えない');
    const row = await h.stores.tasks.get('t1');
    expect(row?.closedAt).toBeDefined();
    expect(row?.closedReason).toBe(' 済んだ ');
  });
});

describe('manager_send の message は HTTP と同じく空文字・NUL だけを断る（#3544）', () => {
  it.each(['', '\u0000', '\u0000\u0000'])('message %j は断り、送らない', async (message) => {
    const h = harness();
    const out = await h.call('manager_send', { managerId: 'mgr-1', message });
    expect(out).toContain('message は使えない');
    expect(h.sent).toEqual([]);
  });

  it.each(['続けて', ' ', 'a\u0000b'])('message %j は従来どおり送る', async (message) => {
    const h = harness();
    const out = await h.call('manager_send', { managerId: 'mgr-1', message });
    expect(out).not.toContain('message は使えない');
    expect(h.sent).toEqual([{ managerId: 'mgr-1', message }]);
  });
});
