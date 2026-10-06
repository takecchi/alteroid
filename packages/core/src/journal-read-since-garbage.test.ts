import { describe, expect, it } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

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

describe('journal_read — since が日付として読めない／存在しない日付のとき', () => {
  it('「foo 1」を日時として受け取らない（V8 の緩い読みで 2001 年になる）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'one',
    });

    const reply = await call(stores)('journal_read', { since: 'foo 1' });

    expect(reply).toContain('日時として読めない');
  });

  it('存在しない日付「2026-02-31」を黙って 3/3 へずらさない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'one',
    });

    const reply = await call(stores)('journal_read', { since: '2026-02-31' });

    expect(reply).toContain('日時として読めない');
  });
});
