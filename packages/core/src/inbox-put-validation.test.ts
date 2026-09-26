import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `InboxStore.put()` の3実装の食い違い（issue #1668）。
 *
 * fs / pg の `put()` は `inboxEventSchema.parse(event)` を通してから書く
 * （`packages/storage-fs/src/inbox.ts` の `put()` / `packages/storage-pg
 * /src/inbox.ts` の `put()`）。**インメモリ実装だけが検査を持たず**、形の
 * 崩れた event（`at` が ISO 8601 でない等）もそのまま保存していた——
 * #1652 / #1655（`ScheduleStore.put()` / `CommitmentStore.open()` /
 * `TokenPoolStore` 各種）と同じ形の揃え漏れで、#1655 の表には挙がって
 * いなかった（同 PR は `InboxStore` について同着の再配達の並びだけを
 * 扱っている）。
 *
 * ここは fs / pg を基準にした期待値（形式不正な event は throw する）を
 * インメモリにも当てる歯——`createMemoryStores()` の `inbox.put` が
 * `inboxEventSchema.parse` を通すようになったので緑になる
 * （`packages/storage-fs/src/inbox-put-validation.test.ts` /
 * `packages/storage-pg/src/inbox-put-validation.test.ts` と同じ形）。
 *
 * #1655 が足した「再配達を末尾へ回す」振る舞い（`inbox-reput-order.test.ts`）
 * はここでは変えない——別の歯として残る。
 */
describe('InboxStore.put() — 形式不正な event の扱い（インメモリ実装）', () => {
  const badEvent = {
    type: 'human_message',
    id: 'evt-bad',
    at: 'not-a-date', // inboxEventSchema は at を ISO 8601 として要求する
    conversationId: 'c',
    text: 'x',
  } as unknown as InboxEvent;

  it('put() は fs / pg と同じく、at が ISO 8601 でない event を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.inbox.put(badEvent, 'not-a-date')).rejects.toThrow();
  });
});
