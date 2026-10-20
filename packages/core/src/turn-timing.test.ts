import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { foldClaudeMessage } from './claude-provider.js';
import { TURN_TIMING_TOP_TOOLS, TurnTimer } from './turn-timing.js';

// 1ターンを段に分けて時間を測る時計（#5086）と、その材料を SDK の形から写す側

function clock(start: number) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

describe('TurnTimer', () => {
  it('⭐ 段を足し込み、順番待ち・最初の文字・最初の応答・モデル・後始末を測る', async () => {
    const c = clock(10_000);
    // 合図は取り出す 2 秒前に積まれていた
    const timer = new TurnTimer({
      now: c.now,
      arrivedAt: 8_000,
      triggers: ['human_message', 'human_message'],
      batchSize: 2,
    });
    await timer.time('prepare.situation', async () => {
      c.advance(300);
    });
    timer.add('prepare', 300);
    timer.turnStarted('normal', 'conv-1');
    timer.add('sessionStart', 0);
    c.advance(50);
    timer.add('composeInput', 50);
    timer.modelStarted();
    c.advance(1_200);
    timer.toolStarted('t1', 'Bash');
    c.advance(4_000);
    timer.toolEnded(['t1', 'unknown']);
    c.advance(500);
    timer.responded('text');
    c.advance(1_000);
    timer.turnEnded({
      succeeded: true,
      sdk: { durationMs: 6_700, durationApiMs: 2_500, numTurns: 2 },
      tokens: { input: 1, cacheRead: 500_000, cacheCreation: 2_000, output: 100 },
    });
    await timer.time('finalize.usage', async () => {
      c.advance(200);
    });
    c.advance(100);

    const record = timer.finish();

    expect(record.triggers).toEqual(['human_message']);
    expect(record.batchSize).toBe(2);
    expect(record.kinds).toEqual(['normal']);
    expect(record.conversationId).toBe('conv-1');
    expect(record.phases).toEqual({
      queue: 2_000,
      'prepare.situation': 300,
      prepare: 300,
      sessionStart: 0,
      composeInput: 50,
      model: 6_700,
      'finalize.usage': 200,
      finalize: 300,
    });
    // 合図が積まれてから: 2,000 + 300 + 50 + 6,700 + 300
    expect(record.totalMs).toBe(9_350);
    // 最初の文字: 積まれてから 2,000 + 300 + 50 + 1,200 + 4,000 + 500
    expect(record.firstTextMs).toBe(8_050);
    // 最初の応答（道具）: 投げてから 1,200
    expect(record.firstResponseMs).toBe(1_200);
    expect(record.tools).toEqual({
      count: 1,
      totalMs: 4_000,
      top: [{ name: 'Bash', count: 1, totalMs: 4_000, maxMs: 4_000 }],
    });
    expect(record.sdk).toEqual({ durationMs: 6_700, durationApiMs: 2_500, numTurns: 2 });
    expect(record.tokens).toEqual({
      input: 1,
      cacheRead: 500_000,
      cacheCreation: 2_000,
      output: 100,
    });
  });

  it('要約は始まりから終わりまでを数え、始まりが分からない回は回数だけ数える', () => {
    const c = clock(0);
    const timer = new TurnTimer({ now: c.now, arrivedAt: 0, triggers: ['timer'], batchSize: 1 });
    timer.turnStarted('normal', null);
    timer.modelStarted();
    timer.compactionStarted();
    c.advance(30_000);
    timer.compactionEnded();
    timer.compactionEnded();
    timer.turnEnded({ succeeded: true });

    expect(timer.finish().compactions).toEqual({ count: 2, totalMs: 30_000 });
  });

  it('閉じていない道具は、結果の時刻で閉じたものとして数える', () => {
    const c = clock(0);
    const timer = new TurnTimer({ now: c.now, arrivedAt: 0, triggers: ['timer'], batchSize: 1 });
    timer.turnStarted('normal', null);
    timer.modelStarted();
    timer.toolStarted('t1', 'Agent');
    c.advance(9_000);
    timer.turnEnded({ succeeded: false });
    c.advance(1_000);

    const record = timer.finish();
    expect(record.succeeded).toBe(false);
    expect(record.tools?.top[0]).toEqual({ name: 'Agent', count: 1, totalMs: 9_000, maxMs: 9_000 });
  });

  it(`道具は名前ごとに集約し、合計の長い順に ${String(TURN_TIMING_TOP_TOOLS)} 件までにする`, () => {
    const c = clock(0);
    const timer = new TurnTimer({ now: c.now, arrivedAt: 0, triggers: ['timer'], batchSize: 1 });
    timer.turnStarted('normal', null);
    for (let index = 0; index < TURN_TIMING_TOP_TOOLS + 3; index += 1) {
      timer.toolStarted(`t${String(index)}`, `tool-${String(index)}`);
      c.advance(index + 1);
      timer.toolEnded([`t${String(index)}`]);
    }
    timer.toolStarted('again', 'tool-0');
    c.advance(100);
    timer.toolEnded(['again']);

    const tools = timer.finish().tools;
    expect(tools?.count).toBe(TURN_TIMING_TOP_TOOLS + 4);
    expect(tools?.top).toHaveLength(TURN_TIMING_TOP_TOOLS);
    expect(tools?.top[0]).toEqual({ name: 'tool-0', count: 2, totalMs: 101, maxMs: 100 });
  });

  it('ターンが入らなかった回は turnStartedAny が偽（呼び手は行を書かない）', () => {
    const c = clock(0);
    const timer = new TurnTimer({ now: c.now, arrivedAt: 0, triggers: ['external'], batchSize: 1 });
    expect(timer.turnStartedAny).toBe(false);
  });
});

describe('SDK の形から時間の材料を写す（foldClaudeMessage）', () => {
  it('⭐ tool_use の id と、tool_result が答えた id を運ぶ', () => {
    const [used] = foldClaudeMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    expect(used).toMatchObject({ blocks: [{ type: 'tool_use', name: 'Bash', id: 'toolu_9' }] });

    const [returned] = foldClaudeMessage({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'toolu_10', content: 'ok' },
        ],
      },
    } as unknown as SDKMessage);
    expect(returned).toEqual({ type: 'tool_result', toolUseIds: ['toolu_9', 'toolu_10'] });
  });

  it('⭐ 要約の始まり（status: compacting）を運び、requesting や終わりは運ばない', () => {
    const fold = (status: unknown) =>
      foldClaudeMessage({ type: 'system', subtype: 'status', status } as unknown as SDKMessage);
    expect(fold('compacting')).toEqual([{ type: 'compaction_started' }]);
    expect(fold('requesting')).toEqual([]);
    expect(fold(null)).toEqual([]);
  });

  it('⭐ result の所要時間を、失敗した result からも運ぶ', () => {
    const [ended] = foldClaudeMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 12_000,
      duration_api_ms: 9_000,
      num_turns: 4,
      result: '',
    } as unknown as SDKMessage);
    expect(ended).toMatchObject({
      type: 'turn_ended',
      succeeded: false,
      timing: { durationMs: 12_000, durationApiMs: 9_000 },
    });
  });

  it('数値でない所要時間は運ばない（0 を埋めない）', () => {
    const [ended] = foldClaudeMessage({
      type: 'result',
      subtype: 'success',
      duration_ms: 'x',
      result: 'ok',
    } as unknown as SDKMessage);
    expect(ended).not.toHaveProperty('timing');
  });
});
