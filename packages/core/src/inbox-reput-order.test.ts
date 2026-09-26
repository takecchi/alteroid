import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `InboxStore` の3実装の食い違い（issue #1652）。
 *
 * 同じ `at`（受理時刻）を持つ2件のうち、片方が再配達（同じ id で `put()` を
 * 再び呼ばれる——`InboxStore.put` の doc「同じ id なら上書きする（配達回数は
 * 保つ）」）を受けたとき、`peekPending()` / `claimPending()` が返す順序
 * （同着の2次キー）が実装ごとに食い違っていた。
 *
 * - **fs**——`put()` が「既存の行を除いてから配列の末尾へ足す」形
 *   （`FsInboxStore.put`）なので、再配達された行は**配列の末尾へ移動する**。
 * - **pg**——`onConflictDoUpdate` の1文なので行の物理位置が変わり、
 *   `ORDER BY` を付けない `SELECT` の返す順は再配達された行が**末尾寄りに
 *   なる**。
 * - **インメモリ（このファイル）**——かつては `Map` に保持し、`put()` で
 *   既存の id を上書きしても挿入順を変えなかった（JS の `Map` の仕様。
 *   キーの再設定は順序を動かさない）ため、fs / pg と順序が食い違っていた。
 *
 * `InboxStore.peekPending` / `claimPending` の doc（`store.ts`）は
 * 「古い順」としか言っておらず、同着（同じ `at`）のときの2次キーは契約に
 * 無い。**契約にするかどうかは決めず、3実装の振る舞い（再配達された行は
 * 末尾へ回る）を fs / pg 側に揃え、歯で固定する。**
 *
 * いまは `createMemoryStores()` の `put()` が既存の id を一旦 `delete` して
 * から `set` し直す（`Map` の末尾へ回す）ので、fs / pg と同じ順序
 * （`['evt-b', 'evt-a']`）になる。
 */
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
    await stores.inbox.put(evA, at); // 再配達（同じ id・同じ at）

    const order = (await stores.inbox.peekPending()).map((entry) => entry.event.id);
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
