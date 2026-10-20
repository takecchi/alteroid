import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { setup, waitFor, waitForDone } from './clone-test-harness.js';
import type { JournalEntry } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';

// クローンの1ターンを段に分けて時間を測り、1ターン1行の `turn_timing` を日誌へ書く（#5086）

type TurnTimingRow = Extract<JournalEntry, { type: 'turn_timing' }>;

function toolCallAndCompaction(): SDKMessage[] {
  return [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-tool-use',
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-tool-result',
    },
    {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: 'sess-fake',
      uuid: 'uuid-compacting',
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 500_000, post_tokens: 40_000 },
      session_id: 'sess-fake',
      uuid: 'uuid-boundary',
    },
  ] as unknown as SDKMessage[];
}

async function timingRows(stores: ReturnType<typeof createMemoryStores>): Promise<TurnTimingRow[]> {
  return (await stores.journal.list({ types: ['turn_timing'] })).filter(
    (entry): entry is TurnTimingRow => entry.type === 'turn_timing',
  );
}

describe('クローンのターンの時間（turn_timing）', () => {
  it('⭐ 1ターンに1行だけ、段・道具・要約・消費を書く', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      beforeAssistant: () => toolCallAndCompaction(),
      numTurns: () => 3,
      // `num_turns` と `usage` は `modelUsage` があるときだけ写す（本番の成功した result には必ず付く）
      modelUsage: () => ({
        'claude-fake': {
          inputTokens: 12,
          outputTokens: 340,
          cacheReadInputTokens: 520_000,
          cacheCreationInputTokens: 8_000,
          webSearchRequests: 0,
          costUSD: 0,
        },
      }),
      resultUsage: () => ({
        input_tokens: 12,
        output_tokens: 340,
        cache_read_input_tokens: 520_000,
        cache_creation_input_tokens: 8_000,
      }),
    });

    s.clone.post(humanMessage('調べて'));
    await waitForDone(s.events);
    await waitFor(async () => (await timingRows(stores)).length === 1, 'turn_timing の1行');

    const [row] = await timingRows(stores);
    expect(row?.triggers).toEqual(['human_message']);
    expect(row?.batchSize).toBe(1);
    expect(row?.kinds).toEqual(['normal']);
    expect(row?.succeeded).toBe(true);
    for (const phase of ['queue', 'prepare', 'sessionStart', 'composeInput', 'model', 'finalize']) {
      expect(row?.phases, phase).toHaveProperty(phase);
    }
    expect(row?.phases).toHaveProperty(['prepare.situation']);
    expect(row?.phases).toHaveProperty(['finalize.usage']);
    expect(row?.tools?.count).toBe(1);
    expect(row?.tools?.top[0]?.name).toBe('Read');
    expect(row?.compactions?.count).toBe(1);
    expect(row?.sdk?.numTurns).toBe(3);
    expect(row?.tokens).toEqual({
      input: 12,
      cacheRead: 520_000,
      cacheCreation: 8_000,
      output: 340,
    });
    expect(row?.firstTextMs).toBeDefined();
    expect(row?.firstResponseMs).toBeDefined();
    expect(row?.totalMs).toBeGreaterThanOrEqual(row?.phases.model ?? 0);

    await s.clone.stop();
  });

  it('2ターン回せば2行になる（束ねない別々の合図）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      'done イベントが2件届く',
    );
    await waitFor(async () => (await timingRows(stores)).length === 2, 'turn_timing の2行');

    await s.clone.stop();
  });

  it('失敗したターンも、失敗として1行書く', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: () => ({ subtype: 'error_during_execution', text: 'API Error: 500' }),
    });

    s.clone.post(humanMessage('やって'));
    await waitFor(async () => (await timingRows(stores)).length === 1, 'turn_timing の1行');

    const [row] = await timingRows(stores);
    expect(row?.succeeded).toBe(false);

    await s.clone.stop();
  });
});
