import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

async function readTurnUsage(requestStats: Record<string, number> | undefined): Promise<string> {
  const stores = createMemoryStores();
  const row = await stores.journal.append({
    type: 'turn_usage',
    layer: 'manager',
    site: 'peer',
    managerId: 'mgr-1',
    models: {},
    ...(requestStats === undefined ? {} : { requestStats }),
  } as never);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const tool = tools.find((entry) => entry.name === 'journal_read');
  if (!tool) throw new Error('journal_read が無い');
  const result = await tool.handler({ id: row.id } as never, {});
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

describe('journal_read: turn_usage の requestStats', () => {
  it('peer のターンの統計の数が本文に出る', async () => {
    const text = await readTurnUsage({
      requests: 3,
      maxInputTokens: 5000,
      firstRequestInputTokens: 1000,
      firstRequestCachedInputTokens: 800,
      firstRequestCacheHitRatio: 0.8,
    });
    expect(text).toContain('requests=3 maxIn=5000 firstIn=1000 firstCached=800 firstHit=0.80');
  });

  it('読めなかった欄は 0 にせず書かない。統計が無い行には行ごと出ない', async () => {
    const partial = await readTurnUsage({ requests: 2, maxInputTokens: 700 });
    expect(partial).toContain('requests=2 maxIn=700');
    expect(partial).not.toContain('firstIn=');
    expect(partial).not.toContain('firstHit=');
    expect(await readTurnUsage(undefined)).not.toContain('requests=');
  });
});
