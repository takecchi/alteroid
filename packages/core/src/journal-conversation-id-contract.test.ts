import { describe, expect, it } from 'vitest';

import { verifyJournalStoreConversationIdContract } from './journal-conversation-id-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の conversationId 契約（インメモリ実装）', () => {
  it('その会話の行だけ／limit より前／with・after と併用／墓標は外れる／空文字は絞らないへ倒さない', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreConversationIdContract(stores.journal)).resolves.toBeUndefined();
  });
});
