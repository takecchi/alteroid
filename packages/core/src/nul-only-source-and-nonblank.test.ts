import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return {
    stores,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

describe('commitment_open の source が NUL だけ・空文字', () => {
  it.each(['\u0000', '\u0000\u0000', ''])('source %j は断り、行を作らない', async (source) => {
    const h = harness();
    const text = await h.call('commitment_open', { body: '本文', source });
    const { entries } = await h.stores.commitments.list();
    expect(entries).toEqual([]);
    expect(text).toMatch(/source/);
  });

  it('source が実のある文字列なら積む', async () => {
    const h = harness();
    await h.call('commitment_open', { body: '本文', source: 'issue-1' });
    const { entries } = await h.stores.commitments.list();
    expect(entries.map((e) => e.source)).toEqual(['issue-1']);
  });
});
