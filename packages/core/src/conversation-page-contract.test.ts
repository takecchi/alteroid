import { describe, expect, it } from 'vitest';

import { verifyConversationPageContract } from './conversation-page-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * 会話の一覧の頁送りの契約を **インメモリ実装** に対して測る。
 * 同じ形の歯が3つ在る（`journal-order-with-contract.test.ts` と同じ作法）:
 * fs は `packages/storage-fs/src/index.test.ts`、pg は
 * `packages/storage-pg/src/index.journal-jobs-schedule.test.ts`。
 */
describe('会話の一覧の頁送りの契約（インメモリ実装）', () => {
  it('頁の連結=全件／窓より小さい頁でも同じ／同着を飛ばさない／使えない継続点は断る', async () => {
    const stores = createMemoryStores();
    await expect(verifyConversationPageContract(stores.journal)).resolves.toBeUndefined();
  });
});
