import { describe, expect, it } from 'vitest';

import { verifyScheduleRunContract } from './schedule-run-contract.js';
import { createMemoryStores } from './testing.js';

/** `ScheduleStore` の発火の印と編集の契約を、インメモリ実装に対して測る。fs と pg も同じ関数を呼ぶ。 */
describe('ScheduleStore の claimRun・completeRun・editRequest の契約（インメモリ実装）', () => {
  it('発火の印は更新前の姿を返して立ち、完了で消え、編集は印を消さない', async () => {
    await expect(
      verifyScheduleRunContract(createMemoryStores().schedules),
    ).resolves.toBeUndefined();
  });
});
