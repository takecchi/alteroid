import { describe, expect, it } from 'vitest';

import { verifyPersonaNulContract } from './persona-nul-contract.js';
import { createMemoryStores } from './testing.js';

/** `PersonaStore` の本文の NUL の契約（issue #2927）を、インメモリ実装に対して測る。fs と pg も同じ関数を呼ぶ。 */
describe('PersonaStore の NUL の契約（インメモリ実装）', () => {
  it('本文の NUL は落として残し、slug の NUL は断る', async () => {
    await expect(verifyPersonaNulContract(createMemoryStores().persona)).resolves.toBeUndefined();
  });
});
