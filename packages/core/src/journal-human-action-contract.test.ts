import { describe, expect, it } from 'vitest';

import { verifyJournalStoreHumanActionContract } from './journal-human-action-contract.js';
import { journalEntrySchema } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の decision.humanAction 契約（インメモリ実装）', () => {
  it('humanAction は追記して読み戻しても欄ごと返り、無い行は印なしのまま読める', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreHumanActionContract(stores.journal)).resolves.toBeUndefined();
  });
});

describe('journalEntrySchema の decision.humanAction', () => {
  const base = {
    type: 'decision',
    id: 'd1',
    at: '2026-01-01T00:00:00.000Z',
    decision: '台帳の行を閉じた',
    grounds: '人間が直接 API から閉じた',
  };

  it('humanAction の無い古い行は印なしとして読める', () => {
    const parsed = journalEntrySchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'decision') {
      expect(parsed.data.humanAction).toBeUndefined();
    }
  });

  it('未知の kind の行は、他の enum 欄（turnFailureKind など）と同じく行ごと読めない行になる（別の種類へ読み替えない）', () => {
    const parsed = journalEntrySchema.safeParse({
      ...base,
      humanAction: {
        kind: 'future_kind',
        target: 'x',
        via: { kind: 'operator', auth: 'disabled' },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('via は answeredVia の形だけを受ける', () => {
    const parsed = journalEntrySchema.safeParse({
      ...base,
      humanAction: { kind: 'commitment_close', target: 'c-1', via: { kind: 'integration' } },
    });
    expect(parsed.success).toBe(false);
  });
});
