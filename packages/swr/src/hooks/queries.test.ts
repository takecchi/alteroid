import { summarizeJournalEntry as fromLogic } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

import { summarizeJournalEntry } from './queries';

describe('summarizeJournalEntry の再 export', () => {
  it('queries.ts から @alteroid/logic の実体がそのまま見える', () => {
    expect(summarizeJournalEntry).toBe(fromLogic);
  });
});
