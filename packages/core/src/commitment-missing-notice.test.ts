import { describe, expect, it } from 'vitest';

import type { CommitmentList, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

describe('commitment_list id=（単票）が「無い」をどう名乗るか（#1028）', () => {
  function reader(stores: Stores) {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    expect(found, 'commitment_list という道具が無い').toBeDefined();
    return async (args: Record<string, unknown>) => {
      const result = await found?.handler(args as never, {} as never);
      return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    };
  }

  function storesWithListing(answer: () => Promise<CommitmentList>): Stores {
    const stores = createMemoryStores();
    return { ...stores, commitments: { ...stores.commitments, list: answer } };
  }

  it('削除を1件も申告しないストアでは、これまでどおり「id が違う」と言い切る', async () => {
    const stores = createMemoryStores();
    const text = await reader(stores)({ id: 'c-nope' });
    expect(text).toContain('id が違う');
  });

  it('物理削除を申告しているストアでは、「id が違う」と言い切らずに件数を断る', async () => {
    const stores = storesWithListing(async () => ({
      entries: [],
      unreadable: [],
      trimmedClosed: 7,
    }));

    const text = await reader(stores)({ id: 'c-nope' });

    expect(text).toContain('言い切れない');
    expect(text).toContain('7');
    expect(text).not.toContain('は無い（id が違う）。');
    // 「この id は消えた」と名乗らない: 消した id はどの実装も控えていないため
    expect(text).not.toContain('この id は消えた');
  });

  it('台帳を読み直せなかった回を、削除0件と混ぜない', async () => {
    const stores = storesWithListing(async () => {
      throw new Error('台帳を読めない');
    });

    const text = await reader(stores)({ id: 'c-nope' });

    expect(text).toContain('読めなかった');
    expect(text).not.toContain('は無い（id が違う）。');
  });
});
