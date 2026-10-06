import { describe, expect, it } from 'vitest';

import { UnreadableJournalEntryError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `journal_read id=` / `conversation_read id=` が、「無い」と「在るが読めない」を言い分ける（issue #3288）。
 *
 * インメモリは読めない行を持てない（`UnreadableJournalEntryError` の doc）ので、`get` が投げる店を
 * 包みで作る。fs の実物は `packages/storage-fs/src/journal-unreadable-get.test.ts`。
 */

const UNREADABLE_ID = 'bad-1';

function storesWithUnreadableRow(): Stores {
  const base = createMemoryStores();
  return {
    ...base,
    journal: {
      ...base.journal,
      get: (id: string) =>
        id === UNREADABLE_ID
          ? Promise.reject(new UnreadableJournalEntryError({ id }))
          : base.journal.get(id),
    },
  };
}

function call(stores: Stores) {
  const list = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === name);
    if (!found) throw new Error(`道具 ${name} が無い`);
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

describe('journal_read id= — 在るが読めない行（issue #3288）', () => {
  it('読めない行は「在るが読めない（形が合わない）」と言い、「無い／まだ書かれていない」とは言わない', async () => {
    const reply = await call(storesWithUnreadableRow())('journal_read', { id: UNREADABLE_ID });

    expect(reply).toContain(`日誌 ${UNREADABLE_ID} は在るが読めない（形が合わない`);
    expect(reply).not.toContain('は無い');
    expect(reply).not.toContain('まだ書かれていない（');
  });

  it('無い id は従来どおり「無い（id が違うか、まだ書かれていない）」と言う', async () => {
    const reply = await call(storesWithUnreadableRow())('journal_read', { id: 'no-such-id' });

    expect(reply).toBe('日誌 no-such-id は無い（id が違うか、まだ書かれていない）。');
  });

  it('読める行は従来どおり全文を返す', async () => {
    const stores = storesWithUnreadableRow();
    const written = await stores.journal.append({
      type: 'decision',
      decision: '探している行',
      grounds: 'g',
    });

    const reply = await call(stores)('journal_read', { id: written.id });

    expect(reply).toContain('探している行');
  });

  it('conversation_read id= も、読めない行を「無い」と言わない（無い id は従来どおり）', async () => {
    const run = call(storesWithUnreadableRow());

    expect(await run('conversation_read', { id: UNREADABLE_ID })).toContain(
      `発言 ${UNREADABLE_ID} は在るが読めない（形が合わない`,
    );
    expect(await run('conversation_read', { id: 'no-such-id' })).toBe(
      '発言 no-such-id は無い（id が違うか、まだ書かれていない）。',
    );
  });
});
