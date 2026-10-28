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
  function model(name: string, costUsd: number, inputTokens: number, outputTokens: number) {
    return [
      name,
      {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 123_456,
        cacheCreationInputTokens: 7_890,
        costUsd,
        webSearchRequests: 0,
      },
    ] as const;
  }

  const contextUsage = {
    durationMs: 840,
    totalTokens: 98_000,
    rawMaxTokens: 1_000_000,
    percentage: 9.8,
    autoCompactThreshold: 900_000,
    isAutoCompactEnabled: true,
    categories: [
      { name: 'System prompt', tokens: 9_200, kind: 'used' },
      { name: 'System tools', tokens: 14_000, kind: 'used' },
      { name: 'MCP tools', tokens: 21_000, kind: 'used' },
      { name: 'Messages', tokens: 50_700, kind: 'used' },
      { name: 'Free space', tokens: 902_000, kind: 'free' },
    ],
    mcpToolTokens: 21_000,
    mcpToolCount: 96,
    mcpToolsByServer: [{ name: 'alteroid', count: 90, tokens: 20_000 }],
    memoryFileTokens: 3_100,
    memoryFileCount: 2,
    systemPromptTokens: 9_200,
    systemPromptSectionCount: 14,
    messageBreakdown: {
      toolCallTokens: 6_000,
      toolResultTokens: 30_000,
      attachmentTokens: 500,
      assistantMessageTokens: 9_000,
      userMessageTokens: 5_200,
      toolsByName: [
        { name: 'Bash', callTokens: 1_000, resultTokens: 9_000 },
        { name: 'Read', callTokens: 800, resultTokens: 8_000 },
        { name: 'Edit', callTokens: 2_000, resultTokens: 300 },
      ],
    },
  };

  async function turnUsageRow(models: Record<string, unknown>, withContext: boolean) {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'turn_usage',
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      models,
      ...(withContext ? { contextUsage } : {}),
    } as never);
    const listing = await tools(stores)('journal_read', { types: ['turn_usage'] });
    // 1 件の一覧: 1行目が見出し、2行目が本文の抜粋
    return listing.split('\n')[1] ?? '';
  }

  it('turn_usage は2つ目のモデルの in/out まで一覧に出る（1つ目の行が 120 字を超えても字数が尽きない）', async () => {
    const row = await turnUsageRow(
      Object.fromEntries([
        model('claude-opus-4-1-20250805', 0.5, 120, 2_400),
        model('claude-sonnet-4-5-20250929', 0.0312, 40, 800),
      ]),
      false,
    );

    expect(row).toContain('claude-opus-4-1-20250805');
    expect(row).toContain('claude-sonnet-4-5-20250929: $0.0312');
    expect(row).toContain('in=40 out=800');
  });

  it('turn_usage のモデルは3本まで。超えた分は「…ほか N モデル」に畳む', async () => {
    const row = await turnUsageRow(
      Object.fromEntries([
        model('model-a', 0.1, 1, 1),
        model('model-b', 0.2, 2, 2),
        model('model-c', 0.3, 3, 3),
        model('model-d', 0.4, 4, 4),
        model('model-e', 0.5, 5, 5),
      ]),
      false,
    );

    expect(row).toContain('model-c');
    expect(row).not.toContain('model-d');
    expect(row).toContain('…ほか 2 モデル');
  });

  it('contextUsage 付きの turn_usage は、モデルの行のほかをまとめて1本の上限で切る（行が膨らまない）', async () => {
    const row = await turnUsageRow(
      Object.fromEntries([
        model('claude-opus-4-1-20250805', 0.5, 120, 2_400),
        model('claude-sonnet-4-5-20250929', 0.0312, 40, 800),
        model('claude-haiku-4-5-20251001', 0.0021, 10, 100),
      ]),
      true,
    );

    // モデル3行（各 80 字前後）＋残りの1本（120 字 + 注記）＋区切り。文脈・内訳・カテゴリを1行ずつ並べると 700 字を超える
    expect(row.length).toBeLessThan(520);
    expect(row).toContain('in=10 out=100');
    expect(row).toMatch(/…（全 [\d,]+ 字）$/);
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
