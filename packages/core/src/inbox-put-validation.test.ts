import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('InboxStore.put() — 形式不正な event の扱い（インメモリ実装）', () => {
  const badEvent = {
    type: 'human_message',
    id: 'evt-bad',
    at: 'not-a-date',
    conversationId: 'c',
    text: 'x',
  } as unknown as InboxEvent;

  it('put() は fs / pg と同じく、at が ISO 8601 でない event を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.inbox.put(badEvent, 'not-a-date')).rejects.toThrow();
  });
});
