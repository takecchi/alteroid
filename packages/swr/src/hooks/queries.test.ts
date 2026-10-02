/**
 * `summarizeJournalEntry` は `@alteroid/logic` へ移した（#2558。文言のテストは
 * `packages/logic/src/journal-summary.test.ts`）。ここでは、既存の import 元
 * （`./queries`・`@alteroid/swr`）が同じ関数を指し続けることだけを見る。
 */
import { summarizeJournalEntry as fromLogic } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

import { summarizeJournalEntry } from './queries';

describe('summarizeJournalEntry の再 export', () => {
  it('queries.ts から @alteroid/logic の実体がそのまま見える', () => {
    expect(summarizeJournalEntry).toBe(fromLogic);
  });
});
