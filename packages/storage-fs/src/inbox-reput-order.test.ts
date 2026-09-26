import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/inbox-reput-order.test.ts` の冒頭コメントを見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——fs は再配達された行を配列の
 * 末尾へ移す（`FsInboxStore.put` が「既存の行を除いてから足す」形のため）
 * ので、この歯は緑になる。
 */
describe('InboxStore — 同着の2次キー（再配達された行は末尾へ回る。fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

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

  it('put(A) → put(B) → put(A) 再配達（同じ at）の後、peekPending() は (B, A) になる', async () => {
    await stores.inbox.put(evA, at);
    await stores.inbox.put(evB, at);
    await stores.inbox.put(evA, at); // 再配達（同じ id・同じ at）

    const order = (await stores.inbox.peekPending()).map((entry) => entry.event.id);
    expect(order).toEqual(['evt-b', 'evt-a']);
  });

  it('claimPending() も同じ順序になる', async () => {
    await stores.inbox.put(evA, at);
    await stores.inbox.put(evB, at);
    await stores.inbox.put(evA, at);

    const order = (await stores.inbox.claimPending()).map((entry) => entry.event.id);
    expect(order).toEqual(['evt-b', 'evt-a']);
  });
});
