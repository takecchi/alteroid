import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function caller(stores: Stores, name: string) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: { runningManagerOwning: () => undefined } as never,
    dropQueuedInboxEvents: async (ids) => ids.length,
  });
  const found = tools.find((entry) => entry.name === name);
  expect(found, `${name} という道具が無い`).toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

describe('配列の要素が NUL だけの呼びは、空文字の要素と同じく入口で断る', () => {
  it('task_set_status_many: source: ["\\0"] は断り、task は1件も変わらない', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add({
      id: 't-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      origin: 'external',
      title: '仕事',
      body: '仕事',
      source: 'mgr-1',
    });
    const call = caller(stores, 'task_set_status_many');
    const args = { origin: ['external'], status: 'done', reason: 'r', dryRun: false };
    const empty = await call({ ...args, source: [''] });
    const nul = await call({ ...args, source: ['\0'] });
    expect(empty).toContain('source は使えない');
    expect(nul, `空文字は断るのに NUL だけは通る:\n${nul}`).toContain('source は使えない');
    expect((await stores.tasks.list()).entries.map((e) => e.id)).toEqual(['t-1']);
  });

  it('inbox_remove_many: sources: ["\\0"] は断り、未読は1件も変わらない', async () => {
    const stores = createMemoryStores();
    const event = {
      type: 'external',
      id: 'e-1',
      at: '2026-01-01T00:00:00.000Z',
      source: 'webhook',
    } as InboxEvent;
    await stores.inbox.put(event, event.at);
    const call = caller(stores, 'inbox_remove_many');
    const empty = await call({ types: ['external'], sources: [''], reason: 'r', dryRun: false });
    const nul = await call({ types: ['external'], sources: ['\0'], reason: 'r', dryRun: false });
    expect(empty).toContain('sources は使えない');
    expect(nul, `空文字は断るのに NUL だけは通る:\n${nul}`).toContain('sources は使えない');
    expect((await stores.inbox.peekPending()).entries.map((r) => r.event.id)).toEqual(['e-1']);
  });

  it('archive_remove_many: sessionIds: ["\\0"] は断り、本文は消えない', async () => {
    const stores = createMemoryStores();
    const oldRow = await stores.archive.archive('sess-a', 'AAA');
    await stores.archive.archive('sess-a', 'AAABBB');
    const call = caller(stores, 'archive_remove_many');
    const empty = await call({ sessionIds: [''], summary: 's', dryRun: false });
    const nul = await call({ sessionIds: ['\0'], summary: 's', dryRun: false });
    expect(empty).toContain('sessionIds は使えない');
    expect(nul, `空文字は断るのに NUL だけは通る:\n${nul}`).toContain('sessionIds は使えない');
    expect(await stores.archive.read(oldRow.id)).toEqual({ kind: 'body', body: 'AAA' });
  });
});

describe('NUL が混じっても中身が残る要素は、今までどおり入口を通る', () => {
  it('inbox_remove_many: sources: ["web\\0hook"] は要素の断りに当たらない', async () => {
    const call = caller(createMemoryStores(), 'inbox_remove_many');
    const out = await call({ types: ['external'], sources: ['web\0hook'], reason: 'r' });
    expect(out).not.toContain('sources は使えない');
  });

  it('archive_remove_many: sessionIds: ["sess\\0-a"] は要素の断りに当たらない', async () => {
    const call = caller(createMemoryStores(), 'archive_remove_many');
    const out = await call({ sessionIds: ['sess\0-a'], summary: 's' });
    expect(out).not.toContain('sessionIds は使えない');
  });

  it('task_set_status_many: source: ["mgr\\0-1"] は要素の断りに当たらない', async () => {
    const call = caller(createMemoryStores(), 'task_set_status_many');
    const out = await call({
      origin: ['external'],
      source: ['mgr\0-1'],
      status: 'done',
      reason: 'r',
    });
    expect(out).not.toContain('source は使えない');
  });
});
