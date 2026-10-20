import { describe, expect, it } from 'vitest';

import { heuristicChars } from './quantity.js';
import type { CloneRuntimeFacts } from './self.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import {
  describeTurnTimingBody,
  describeTurnTimingHead,
  renderTurnTimingSummary,
  type TurnTimingEntry,
} from './turn-timing-format.js';

// `turn_timing`（#5086）を「どの段で何秒、なぜ」が読める形にする

const RUNTIME: CloneRuntimeFacts = {
  revision: { commit: null, short: null, source: null },
  buildTime: { builtAt: null },
  declaredModel: 'fable',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: null,
  requestedEffort: null,
  claudeCodeVersion: null,
  apiKeySource: null,
  permissionMode: null,
  requestedPermissionMode: 'auto',
  mcpServers: [],
  sessionId: null,
  resumedFrom: null,
  injectedMemoryChars: heuristicChars(0),
  systemPromptChars: heuristicChars(0),
  lastContextUsage: null,
};

function entry(overrides: Partial<TurnTimingEntry> = {}): TurnTimingEntry {
  return {
    type: 'turn_timing',
    id: 'tt-1',
    at: '2026-10-20T00:00:00.000Z',
    triggers: ['human_message'],
    batchSize: 1,
    kinds: ['normal'],
    succeeded: true,
    totalMs: 61_000,
    firstTextMs: 45_000,
    firstResponseMs: 40_000,
    phases: {
      queue: 500,
      prepare: 1_500,
      'prepare.situation': 1_200,
      model: 58_000,
      finalize: 1_000,
    },
    tools: {
      count: 3,
      totalMs: 12_000,
      top: [
        { name: 'Bash', count: 2, totalMs: 10_000, maxMs: 9_000 },
        { name: 'Read', count: 1, totalMs: 2_000, maxMs: 2_000 },
      ],
    },
    sdk: { durationMs: 58_000, durationApiMs: 45_000, numTurns: 4 },
    contextTokens: 540_000,
    tokens: { input: 10, cacheRead: 530_000, cacheCreation: 9_000, output: 800 },
    ...overrides,
  };
}

describe('turn_timing の描き方', () => {
  it('⭐ 1行目に合計・最初の文字・最も長い段を出す', () => {
    expect(describeTurnTimingHead(entry())).toBe(
      '[turn_timing normal human_message 成功] 合計 61秒・最初の文字まで 45秒・最も長い段 model 58秒',
    );
  });

  it('⭐ 本文は親の段を長い順に並べ、モデルの段に「なぜ」（最初の応答・道具・要求の本数・文脈・入力）を添える', () => {
    const body = describeTurnTimingBody(entry());
    const lines = body.split('\n');
    expect(lines[0]).toContain('モデル（SDK に投げてから result まで）: 58秒');
    expect(lines[0]).toContain('最初の応答まで 40秒');
    expect(lines[0]).toContain('道具 3 回で 12秒（最も長いのは Bash 2 回 10秒、1回の最長 9.0秒）');
    expect(lines[0]).toContain('要求 4 本');
    expect(lines[0]).toContain('文脈 540,000 トークン');
    expect(lines[0]).toContain('入力 539,010 トークン');
    expect(lines[1]).toContain('ターンの前の組み立て: 1.5秒（situation 1.2秒）');
    // 内訳（`.` 付き）は親と二重に並べない
    expect(body).not.toContain('- prepare.situation');
    expect(body).toContain(
      '消費（このターンのメインループ）: 入力 539,010 トークン（素の入力 10・キャッシュの読み 530,000・キャッシュの書き 9,000）・出力 800',
    );
  });

  it('⭐ 要約は中央値・90% 点・時間を食っている段・1ターンあたりの入力・最も長かったターンを出す', () => {
    const summary = renderTurnTimingSummary([
      entry({ id: 'a', totalMs: 10_000, phases: { model: 9_000, queue: 1_000 } }),
      entry({ id: 'b', totalMs: 61_000 }),
      entry({
        id: 'c',
        totalMs: 20_000,
        phases: { queue: 15_000, model: 5_000 },
        tokens: undefined,
      }),
    ]);
    expect(summary).toContain('直近のターンの時間（3 件。');
    expect(summary).toContain('応答が全部終わるまで: 中央値 20秒・90% 点 61秒');
    expect(summary).toContain(
      '時間を食っている段（合計の多い順）: モデル（SDK に投げてから result まで） 72秒',
    );
    expect(summary).toContain(
      '1ターンあたりの入力（素の入力＋キャッシュの読み・書き）: 中央値 539,010',
    );
    expect(summary).toContain('2 ターンの合計 1,078,020 トークン');
    expect(summary).toContain('最も長い段 モデル（SDK に投げてから result まで） 58秒');
  });

  it('記録が無ければ、まだ無いと言う（0 秒と書かない）', () => {
    expect(renderTurnTimingSummary([])).toContain('まだ記録が無い');
  });
});

describe('self_status に「直近のターンの時間」の節が出る', () => {
  it('⭐ 日誌の turn_timing を読んで要約を出す', async () => {
    const stores = createMemoryStores();
    // 日誌の口は `id` と `at` を自分で付けるので、見本から外して渡す
    const sample: Partial<TurnTimingEntry> = { ...entry() };
    delete sample.id;
    delete sample.at;
    await stores.journal.append(sample as Omit<TurnTimingEntry, 'id' | 'at'>);
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      runtime: () => RUNTIME,
    });
    const tool = tools.find((candidate) => candidate.name === 'self_status');
    const reply = await tool?.handler({} as never, {});
    const text = (reply?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(text).toContain('直近のターンの時間（1 件。');
    expect(text).toContain('最も長い段 モデル');
  });
});
