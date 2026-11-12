import { describe, expect, it } from 'vitest';

import {
  JOURNAL_DIAGNOSTICS_TYPES,
  summarizeJournalDiagnosticsEntry,
  type JournalDiagnosticsEntryLike,
} from './journal-diagnostics-format.js';

describe('summarizeJournalDiagnosticsEntry（issue #2016）', () => {
  it('JOURNAL_DIAGNOSTICS_TYPES はこの4種だけを名乗る', () => {
    expect(JOURNAL_DIAGNOSTICS_TYPES).toEqual([
      'turn_usage',
      'context_usage',
      'turn_timing',
      'http_timing',
    ]);
  });

  describe('http_timing（#5089）', () => {
    it('窓・要求の回数・時間を最も食った経路・最も遅い要求を1行にする', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'http_timing',
        windowMs: 600_000,
        requests: 42,
        routes: [{ route: 'GET /progress', totalMs: 12_000 }],
        slowest: [{ route: 'GET /commitments', totalMs: 3_400 }],
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toBe(
        '[10分の窓] 要求 42 回・時間を最も食った経路 GET /progress 合計 12秒・最も遅い要求 GET /commitments 3.4秒',
      );
    });
  });

  describe('turn_timing（#5086）', () => {
    it('合計・最初の文字・最も長い親の段・入力を1行にする（内訳の段は選ばない）', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'turn_timing',
        triggers: ['human_message'],
        kinds: ['normal'],
        succeeded: true,
        totalMs: 61_000,
        firstTextMs: 45_000,
        phases: { queue: 500, model: 58_000, 'model.extra': 70_000, finalize: 1_000 },
        tokens: { input: 10, cacheRead: 530_000, cacheCreation: 9_000, output: 800 },
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toBe(
        '[normal human_message 成功] 合計 61秒・最初の文字まで 45秒・最も長い段 model 58秒・入力 539,010 トークン',
      );
    });
  });

  describe('turn_usage', () => {
    it('cache read/write を潰さない', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'turn_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        models: {
          'claude-fable-5': {
            costUsd: 0.5,
            cacheReadInputTokens: 120,
            cacheCreationInputTokens: 40,
          },
        },
      };
      const summary = summarizeJournalDiagnosticsEntry(entry);
      expect(summary).toContain('read=120');
      expect(summary).toContain('write=40');
      expect(summary).toContain('$0.5000');
    });

    it('reset があれば注記を出す', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'turn_usage',
        layer: 'manager',
        site: 'session',
        managerId: 'mgr-1',
        models: {},
        reset: { fromCostUsd: 1, toCostUsd: 2 },
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toContain(
        '⚠ 数え直しを挟んだ回（models は差分ではない）',
      );
    });

    it('compactions があれば回数を出す', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'turn_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        models: {},
        compactions: [{}, {}],
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toContain('⚠ compaction 2 回');
    });

    it('contextUsage.percentage があれば文脈の注記を出す', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'turn_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        models: {},
        contextUsage: { percentage: 30, totalTokens: 500 },
      };
      const summary = summarizeJournalDiagnosticsEntry(entry);
      expect(summary).toContain('文脈 30%');
      expect(summary).toContain('500 トークン');
      expect(summary).not.toContain('履歴の道具の結果');
    });

    it('messageBreakdown があれば結果が大きい上位3道具を出し、「ほか」は順位に入れない', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'turn_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        models: {},
        contextUsage: {
          percentage: 30,
          totalTokens: 500,
          messageBreakdown: {
            toolsByName: [
              { name: 'a', callTokens: 1, resultTokens: 40 },
              { name: 'b', callTokens: 1, resultTokens: 30 },
              { name: 'c', callTokens: 1, resultTokens: 20 },
              { name: 'd', callTokens: 1, resultTokens: 10 },
              { name: '(other)', callTokens: 1, resultTokens: 900 },
            ],
          },
        },
      };
      const summary = summarizeJournalDiagnosticsEntry(entry);
      expect(summary).toContain('履歴の道具の結果が大きい順: a 40・b 30・c 20');
      expect(summary).not.toContain('d 10');
      expect(summary).not.toContain('(other)');
    });
  });

  describe('context_usage', () => {
    it('turnSucceeded=false は「ターン失敗」を含む', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'context_usage',
        layer: 'manager',
        site: 'session',
        managerId: 'mgr-1',
        turnSucceeded: false,
        contextUsage: { percentage: 42, totalTokens: 1000 },
      };
      const summary = summarizeJournalDiagnosticsEntry(entry);
      expect(summary).toContain('ターン失敗');
      expect(summary).toContain('文脈 42%');
    });

    it('turnSucceeded=true は「ターン成功」を含む', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'context_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        turnSucceeded: true,
        contextUsage: { percentage: 10 },
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toContain('ターン成功');
    });

    it('contextUsage.error があれば「測れなかった」を言う（percentage の有無に関わらず）', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'context_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        turnSucceeded: false,
        contextUsage: { error: 'ECONNRESET' },
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toContain('測れなかった（ECONNRESET）');
    });

    it('percentage も error も無ければ「（詳細なし）」', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'context_usage',
        layer: 'clone',
        site: 'session',
        managerId: 'clone',
        turnSucceeded: true,
        contextUsage: {},
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toContain('（詳細なし）');
    });
  });
});
