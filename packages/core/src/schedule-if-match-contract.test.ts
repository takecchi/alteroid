import { describe, expect, it } from 'vitest';

import { verifyScheduleIfMatchContract } from './schedule-if-match-contract.js';
import { createMemoryStores } from './testing.js';

/** `ScheduleStore` の前提の版の契約を、インメモリ実装に対して測る。fs と pg も同じ関数を呼ぶ。 */
describe('ScheduleStore の ifMatch の契約（インメモリ実装）', () => {
  it('版が合えば書け、古ければ書かれず、省略は後勝ちで、発火では版が動かない', async () => {
    await expect(
      verifyScheduleIfMatchContract(createMemoryStores().schedules),
    ).resolves.toBeUndefined();
  });
});
