import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('InboxStore — 同着の2次キー（再配達された行は末尾へ回る。インメモリ実装）', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const evA: InboxEvent = {
    type: 'human_message',
    id: 'evt-a',
    at,
    conversationId: 'c',
    text: 'A',
  };
  const evB: InboxEvent = {
    type: 'human_message',
    id: 'evt-b',
    at,
    conversationId: 'c',
    text: 'B',
  };

  it('put(A) → put(B) → put(A) 再配達（同じ at）の後、peekPending() は fs / pg と同じ順（B, A）になる', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(evA, at);
    await stores.inbox.put(evB, at);
    await stores.inbox.put(evA, at);
    const order = (await stores.inbox.peekPending()).entries.map((entry) => entry.event.id);
    expect(order).toEqual(['evt-b', 'evt-a']);
  });

  it('claimPending() も同じ順序を返す', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(evA, at);
    await stores.inbox.put(evB, at);
    await stores.inbox.put(evA, at);

    const order = (await stores.inbox.claimPending()).map((entry) => entry.event.id);
    expect(order).toEqual(['evt-b', 'evt-a']);
  });
});
