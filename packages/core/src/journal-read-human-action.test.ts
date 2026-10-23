import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

async function journalRead(stores: ReturnType<typeof createMemoryStores>): Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'journal_read');
  if (!found) throw new Error('journal_read が無い');
  const result = (await found.handler({ types: ['decision'] } as never, {} as never)) as {
    content: { text: string }[];
  };
  return result.content.map((part) => part.text).join('');
}

describe('journal_read — decision の humanAction の欄', () => {
  it('⭐ 人間の操作の印が付いた decision は、種類・対象・経路が見える', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'decision',
      decision: '台帳の行 c-1 を人間が閉じた',
      grounds: 'API',
      humanAction: {
        kind: 'commitment_close',
        target: 'c-1',
        via: { kind: 'operator', auth: 'operator-token' },
      },
    });

    const reply = await journalRead(stores);

    expect(reply).toContain('humanAction=commitment_close');
    expect(reply).toContain('target=c-1');
    expect(reply).toContain('via=operator（operator token）');
  });

  it('印の無い decision には humanAction の欄を出さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '自分で決めた', grounds: '記憶' });

    const reply = await journalRead(stores);

    expect(reply).toContain('[decision]');
    expect(reply).not.toContain('humanAction=');
  });
});
