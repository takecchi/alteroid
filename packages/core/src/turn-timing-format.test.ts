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
    const summary = renderTurnTimingSummary([]);
    expect(summary).toContain('まだ記録が無い');
    expect(summary).not.toContain('合図別');
  });

  it('⭐ 合図別: 種別ごとにターン数・入力・割合を数え、複数種の束は「束」1つに数える（重複計上しない）', () => {
    const summary = renderTurnTimingSummary([
      entry({ id: 'a', triggers: ['human_message'] }),
      entry({
        id: 'b',
        triggers: ['timer', 'manager_message'],
        batchSize: 2,
        tokens: { input: 0, cacheRead: 539_010, cacheCreation: 0, output: 1 },
      }),
      entry({
        id: 'c',
        triggers: ['timer'],
        tokens: { input: 1, cacheRead: 0, cacheCreation: 0, output: 1 },
      }),
    ]);
    // 合計 539,010 + 539,010 + 1 = 1,078,021
    expect(summary).toContain('human_message 1 ターン 539,010（50%）');
    expect(summary).toContain('束 1 ターン 539,010（50%）');
    expect(summary).toContain('timer 1 ターン 1（0%）');
    expect(summary).not.toContain('manager_message');
  });

  it('⭐ 合図別: トークンが欠けたターンも件数に数え、入力は 0 として足す。全部欠けたら割合を出さない', () => {
    const summary = renderTurnTimingSummary([
      entry({ id: 'a', triggers: ['self_initiative'], tokens: undefined }),
      entry({ id: 'b', triggers: [], tokens: undefined }),
    ]);
    expect(summary).toContain('self_initiative 1 ターン 0 / ? 1 ターン 0');
    expect(summary).not.toContain('ターン 0（');
  });

  it('⭐ 合図別: 種別が多いときは上位だけ出し、残りは件数で言う', () => {
    const summary = renderTurnTimingSummary(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => entry({ id: name, triggers: [name] })),
    );
    expect(summary).toContain('/ 他 2 種');
  });

  it('⭐ 道具を呼ばなかった割合は self_initiative と timer だけ数える', () => {
    const summary = renderTurnTimingSummary([
      entry({ id: 'a', triggers: ['self_initiative'], tools: undefined }),
      entry({ id: 'b', triggers: ['self_initiative'] }),
      entry({ id: 'c', triggers: ['timer'], tools: undefined }),
      entry({ id: 'd', triggers: ['human_message'], tools: undefined }),
    ]);
    expect(summary).toContain(
      '道具を1回も呼ばなかったターン: self_initiative 1/2（50%）・timer 1/1（100%）',
    );
    expect(summary).not.toContain('human_message 1/1');
  });

  it('その2種のターンが無ければ、道具の行は出さない', () => {
    expect(renderTurnTimingSummary([entry()])).not.toContain('道具を1回も呼ばなかった');
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
    expect(text).toContain('合図別の入力');
    expect(text).toContain('human_message 1 ターン 539,010（100%）');
  });
});
