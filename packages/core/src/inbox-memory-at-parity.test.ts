import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('InboxStore.put() — 外側の at の表記（インメモリ実装）', () => {
  const event = (id: string, at: string): InboxEvent => ({
    type: 'human_message',
    id,
    at,
    conversationId: 'c',
    text: id,
  });

  it('+09:00 を渡すと Z で返る（peekPending・claimPending・pending().oldestAt）', async () => {
    const { inbox } = createMemoryStores();
    await inbox.put(event('evt-a', '2026-08-12T09:00:00+09:00'), '2026-08-12T09:00:00+09:00');
    const [peeked] = (await inbox.peekPending()).entries;
    expect(peeked?.at).toBe('2026-08-12T00:00:00.000Z');
    expect((await inbox.pending()).oldestAt).toBe('2026-08-12T00:00:00.000Z');
    const [claimed] = await inbox.claimPending();
    expect(claimed?.at).toBe('2026-08-12T00:00:00.000Z');
    expect(claimed?.event.at).toBe('2026-08-12T09:00:00+09:00');
  });

  it('不正な時刻は put が拒む（throw する。何も保存しない）', async () => {
    const { inbox } = createMemoryStores();
    await expect(
      inbox.put(event('evt-a', '2026-08-12T09:00:00+09:00'), 'not-a-date'),
    ).rejects.toThrow();
    expect((await inbox.pending()).count).toBe(0);
  });
});
