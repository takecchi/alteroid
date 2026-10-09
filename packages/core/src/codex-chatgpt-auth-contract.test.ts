import { describe, expect, it } from 'vitest';

import { verifyCodexChatgptAuthContract } from './codex-chatgpt-auth-contract.js';
import { createMemoryStores } from './testing.js';

describe('CodexChatgptAuthStore の約束（インメモリ実装）', () => {
  it('置く・compare-and-swap・消す', async () => {
    await expect(
      verifyCodexChatgptAuthContract(createMemoryStores().codexAuth),
    ).resolves.toBeUndefined();
  });
});
