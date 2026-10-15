import { describe, it, expect } from 'vitest';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';

// #4921: 起動後の最初の本セッションのターンで、ToolSearch が実際に効いたかを1回だけ渡す
describe('クローン — 最初のターンの ToolSearch の観測（#4921）', () => {
  const modelUsage = () => ({
    'claude-fable-5': {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
    },
  });
  const resultUsage = () => ({
    input_tokens: 100,
    output_tokens: 200,
    cache_read_input_tokens: 9_000,
    cache_creation_input_tokens: 700,
  });
  const contextOf = (
    categories: { name: string; tokens: number; kind?: string }[] | undefined,
  ) => ({
    totalTokens: 12_000,
    rawMaxTokens: 200_000,
    percentage: 6,
    isAutoCompactEnabled: true,
    ...(categories === undefined ? {} : { categories }),
  });

  function observe(
    categories: { name: string; tokens: number; kind?: string }[] | undefined,
    lines: string[],
  ) {
    return setup(
      undefined,
      createMemoryStores(),
      {
        modelUsage,
        resultUsage,
        numTurns: () => 7,
        getContextUsage: () => contextOf(categories),
      },
      {},
      {
        onFirstTurnToolSearch: (line) => {
          lines.push(line);
          return Promise.resolve();
        },
      },
    );
  }

  it('MCP の道具が deferred の回は、その文と要求の本数・使用量の内訳が1回だけ出る（2回目のターンでは出ない）', async () => {
    const lines: string[] = [];
    const s = observe([{ name: 'MCP tools', tokens: 3_000, kind: 'deferred' }], lines);

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      'done イベントが2件届く',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MCP の道具は deferred（名前だけ、3,000 トークン）');
    expect(lines[0]).toContain('文脈 12,000 トークン');
    expect(lines[0]).toContain('要求 7 本');
    expect(lines[0]).toContain(
      '使用量 合計 10,000（入力 100・キャッシュの読み 9,000・キャッシュの書き 700・出力 200）',
    );

    await s.clone.stop();
  });

  it('MCP の道具が used の回は、used の文が出る', async () => {
    const lines: string[] = [];
    const s = observe([{ name: 'MCP tools', tokens: 5_000, kind: 'used' }], lines);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MCP の道具は used（本体ごと、5,000 トークン）');

    await s.clone.stop();
  });

  it('区分が無い回は「取れなかった」と書き、推し量らない', async () => {
    const lines: string[] = [];
    const s = observe(undefined, lines);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MCP の道具の区分は取れなかった');
    expect(lines[0]).not.toContain('deferred（');
    expect(lines[0]).not.toContain('used（');

    await s.clone.stop();
  });

  it('要求の本数が取れない回は、その文を書かない', async () => {
    const lines: string[] = [];
    const s = setup(
      undefined,
      createMemoryStores(),
      {
        modelUsage,
        getContextUsage: () => contextOf([{ name: 'MCP tools', tokens: 1, kind: 'deferred' }]),
      },
      {},
      {
        onFirstTurnToolSearch: (line) => {
          lines.push(line);
          return Promise.resolve();
        },
      },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/要求 \d+ 本/);
    expect(lines[0]).not.toContain('使用量 合計');

    await s.clone.stop();
  });

  it('蒸留のターン（会話の終わり）では増えない', async () => {
    const lines: string[] = [];
    const s = observe([{ name: 'MCP tools', tokens: 3_000, kind: 'deferred' }], lines);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    expect(lines).toHaveLength(1);

    await s.clone.stop();
  });
});
