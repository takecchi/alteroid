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

describe('journal_read — afterId が最古の行を指すとき', () => {
  it('日誌に行が在るのに「日誌はまだ空」と言わない', async () => {
    const stores = createMemoryStores();
    const oldest = await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'one',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'two',
    });

    const reply = await call(stores)('journal_read', { afterId: oldest.id, afterAt: oldest.at });

    expect(reply).not.toContain('日誌はまだ空');
    expect(reply).toContain('この位置より先（古い側）に日誌の行は無い');
  });

  it('本当に空の日誌では、従来どおり「（日誌はまだ空）」と言う', async () => {
    const reply = await call(createMemoryStores())('journal_read', {});

    expect(reply).toContain('（日誌はまだ空）');
  });
});
