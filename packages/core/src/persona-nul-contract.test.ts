import { describe, expect, it } from 'vitest';

import { verifyPersonaNulContract } from './persona-nul-contract.js';
import { createMemoryStores } from './testing.js';

describe('PersonaStore の NUL の契約（インメモリ実装）', () => {
  it('本文の NUL は落として残し、slug の NUL は断る', async () => {
    await expect(verifyPersonaNulContract(createMemoryStores().persona)).resolves.toBeUndefined();
  });
});
