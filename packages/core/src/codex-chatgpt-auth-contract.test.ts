import { describe, expect, it } from 'vitest';

import { verifyCodexChatgptAuthContract } from './codex-chatgpt-auth-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `CodexChatgptAuthStore` の約束（#3939）を、**インメモリ実装**に対して測る。同じ約束を
 * fs（`storage-fs/src/codex-auth.test.ts`）と pg（`storage-pg/src/codex-auth.test.ts`）も呼ぶ。
 */
describe('CodexChatgptAuthStore の約束（インメモリ実装）', () => {
  it('置く・compare-and-swap・消す', async () => {
    await expect(
      verifyCodexChatgptAuthContract(createMemoryStores().codexAuth),
    ).resolves.toBeUndefined();
  });
});
