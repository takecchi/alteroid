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

describe('journal_read — decision の target（やり方の書き込みの印）', () => {
  it('⭐ やり方を書いた decision は、どのやり方かが文面に頼らず head に見える', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'decision',
      decision: '書き直した',
      grounds: 'g',
      target: { kind: 'practice', slug: 'deploy-flow' },
    });

    const reply = await journalRead(stores);

    expect(reply).toContain('[decision practice=deploy-flow]');
  });

  it('人間の操作の印と並ぶときは、両方が head に出る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'decision',
      decision: '人間が書き直した',
      grounds: 'API',
      target: { kind: 'practice', slug: 'deploy-flow' },
      humanAction: {
        kind: 'practice_write',
        target: 'deploy-flow',
        via: { kind: 'operator', auth: 'operator-token' },
      },
    });

    const reply = await journalRead(stores);

    expect(reply).toContain('[decision practice=deploy-flow humanAction=practice_write');
  });

  it('印の無い decision の head は従来の [decision] のまま', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '自分で決めた', grounds: '記憶' });

    const reply = await journalRead(stores);

    expect(reply).toContain('[decision]');
    expect(reply).not.toContain('practice=');
  });
});
