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
  it('commitment_close_many: source: ["\\0"] は断り、台帳は1件も変わらない', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'external',
      body: '仕事',
      source: 'mgr-1',
    });
    const call = caller(stores, 'commitment_close_many');
    const empty = await call({ origin: ['external'], source: [''], reason: 'r', dryRun: false });
    const nul = await call({ origin: ['external'], source: ['\0'], reason: 'r', dryRun: false });
    expect(empty).toContain('source は使えない');
    expect(nul, `空文字は断るのに NUL だけは通る:\n${nul}`).toContain('source は使えない');
    expect((await stores.commitments.list()).entries.map((e) => e.id)).toEqual(['c-1']);
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

  it('commitment_close_many: source: ["mgr\\0-1"] は要素の断りに当たらない', async () => {
    const call = caller(createMemoryStores(), 'commitment_close_many');
    const out = await call({ origin: ['external'], source: ['mgr\0-1'], reason: 'r' });
    expect(out).not.toContain('source は使えない');
  });
});
