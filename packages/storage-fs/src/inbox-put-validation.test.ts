import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1668。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/inbox-put-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`put()` が
 * `inboxEventSchema.parse(event)` を通すので、この歯は緑になる。
 */
describe('InboxStore.put() — 形式不正な event の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const badEvent = {
    type: 'human_message',
    id: 'evt-bad',
    at: 'not-a-date', // inboxEventSchema は at を ISO 8601 として要求する
    conversationId: 'c',
    text: 'x',
  } as unknown as InboxEvent;

  it('put() は at が ISO 8601 でない event を拒む（throw する）', async () => {
    await expect(stores.inbox.put(badEvent, 'not-a-date')).rejects.toThrow();
  });
});
