import { describe, expect, it } from 'vitest';

import { verifyConversationPageContract } from './conversation-page-contract.js';
import { createMemoryStores } from './testing.js';

describe('会話の一覧の頁送りの契約（インメモリ実装）', () => {
  it('頁の連結=全件／窓より小さい頁でも同じ／同着を飛ばさない／使えない継続点は断る', async () => {
    const stores = createMemoryStores();
    await expect(verifyConversationPageContract(stores.journal)).resolves.toBeUndefined();
  });
});
