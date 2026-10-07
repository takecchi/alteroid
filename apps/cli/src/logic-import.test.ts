import { formatBytes, summarizeJournalEntry } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

describe('@alteroid/logic を CLI から読める', () => {
  it('純関数を呼べる', () => {
    expect(
      summarizeJournalEntry({
        type: 'decision',
        id: 'd1',
        at: '2026-10-02T00:00:00.000Z',
        decision: '進める',
        grounds: '根拠',
      }),
    ).toBe('進める（根拠: 根拠）');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
