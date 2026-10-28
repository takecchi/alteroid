import { describe, expect, it } from 'vitest';

import { excerptRow } from './excerpt.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function tools(stores: Stores) {
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

describe('excerptRow — 一覧の行の注記は全体の字数だけにする', () => {
  it('短ければ何も足さず、改行は1行に潰す', () => {
    expect(excerptRow('あ\n\nい', 10)).toBe('あ い');
  });

  it('切ったら「…（全 N 字）」だけを足す（省いた分は 全 − 抜粋 で引ける）', () => {
    expect(excerptRow('あ'.repeat(1_500), 120)).toBe(`${'あ'.repeat(120)}…（全 1,500 字）`);
  });

  it('サロゲートペアを割らない', () => {
    const text = `${'A'.repeat(9)}😀${'B'.repeat(10)}`;
    expect(excerptRow(text, 10)).toBe(`${'A'.repeat(9)}…（全 21 字）`);
  });
});

describe('journal_read — 一覧の注記と turn_usage の見せ方', () => {
  it('turn_usage は2つ目以降のモデルも一覧に出る（1つ目で字数が尽きない）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'turn_usage',
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      models: {
        'claude-opus-4-1-20250805': {
          inputTokens: 120,
          outputTokens: 2400,
          cacheReadInputTokens: 123456,
          cacheCreationInputTokens: 7890,
          costUsd: 0.5,
          webSearchRequests: 0,
        },
        'claude-sonnet-4-5-20250929': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0.0312,
          webSearchRequests: 0,
        },
      },
    } as never);
    const call = tools(stores);

    const listing = await call('journal_read', { types: ['turn_usage'] });

    expect(listing).toContain('claude-opus-4-1-20250805');
    expect(listing).toContain('claude-sonnet-4-5-20250929');
    expect(listing).toContain('$0.0312');
  });

  it('一覧の注記は短く、全文読みは本文を切らない', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'あ'.repeat(600),
    });
    const call = tools(stores);

    const listing = await call('journal_read', {});
    const single = await call('journal_read', { id: entry.id });

    expect(listing).toContain('…（全 600 字）');
    expect(listing).not.toContain('文字省略');
    expect(single).toContain('あ'.repeat(600));
  });
});
