import { describe, expect, it } from 'vitest';

import { verifyScheduleNulContract } from './schedule-nul-contract.js';
import { createMemoryStores } from './testing.js';

describe('ScheduleStore の NUL の契約（インメモリ実装）', () => {
  it('読むだけの口は「無い」と同じ結果を返し、書き込みは鍵を断り本文の NUL を落として残す', async () => {
    await expect(
      verifyScheduleNulContract(createMemoryStores().schedules),
    ).resolves.toBeUndefined();
  });
});
