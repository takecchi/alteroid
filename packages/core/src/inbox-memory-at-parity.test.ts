import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #2927 項目2 の続き。`inbox.put(event, at)` の外側の `at` は、fs / pg が
 * `Z` 付きの ISO 表記（`new Date(at).toISOString()`）に正規化して保存し、読めない時刻は
 * 拒む（対の歯は `packages/storage-fs/src/inbox-at-utc-2927.test.ts` /
 * `packages/storage-pg/src/inbox-at-utc-2927.test.ts`）。インメモリ実装
 * （`createMemoryStores`）だけが、渡された文字列をそのまま持ち、何でも受け付ける。
 * この足場で緑になるテストが、fs / pg では別の `at` を読む／落ちる。
 */
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
    // event の中の at は触らない
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
