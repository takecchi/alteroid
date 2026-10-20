import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 空（または空白・NUL だけ）の入力を、書き込み・委譲の前に断る。
// memory_append: 空の本文でも末尾へ空行を1本足して「追記した」と答え、文書の版を進めていた。
// manager_start: 空の依頼でも日誌に「起こそうとしている」と書き、runner へ空の依頼を渡していた

function toolsOf(stores: Stores, managers?: ManagerPool) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    ...(managers === undefined ? {} : { managers }),
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`${name} が無い`);
    const reply = await tool.handler(args as never, {});
    return (reply.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

describe('memory_append: 空の本文は追記せずに断る', () => {
  it.each(['', '   \n', '\u0000'])(
    '⭐ content=%j は断り、文書も日誌も変えない',
    async (content) => {
      const stores = createMemoryStores();
      await stores.persona.write('notes', '# メモ\n本文\n');
      const before = await stores.persona.read('notes');
      const call = toolsOf(stores);

      const reply = await call('memory_append', { slug: 'notes', content, summary: '追記' });

      expect(reply).not.toContain('追記した');
      expect(reply).toContain('content');
      expect((await stores.persona.read('notes'))?.content).toBe(before?.content);
      expect(await stores.journal.list({ types: ['memory_update'] })).toHaveLength(0);
    },
  );

  it('中身のある本文は今までどおり追記する', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', '# メモ\n本文\n');
    const call = toolsOf(stores);

    const reply = await call('memory_append', { slug: 'notes', content: '足す', summary: '追記' });

    expect(reply).toContain('追記した');
    expect((await stores.persona.read('notes'))?.content).toContain('足す');
  });
});

describe('manager_start: 空の依頼は起こさずに断る', () => {
  it.each(['', '  \n ', '\u0000'])(
    '⭐ request=%j は断り、起こさず日誌も書かない',
    async (request) => {
      const stores = createMemoryStores();
      const started: unknown[] = [];
      const pool = {
        start: async (args: unknown) => {
          started.push(args);
          return { managerId: 'mgr-x' };
        },
      } as unknown as ManagerPool;
      const call = toolsOf(stores, pool);

      const reply = await call('manager_start', { request });

      expect(reply).toContain('request');
      expect(started).toHaveLength(0);
      expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(0);
    },
  );
});
