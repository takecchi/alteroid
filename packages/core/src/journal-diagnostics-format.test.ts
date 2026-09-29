import { describe, expect, it } from 'vitest';

import {
  JOURNAL_DIAGNOSTICS_TYPES,
  summarizeJournalDiagnosticsEntry,
  type JournalDiagnosticsEntryLike,
} from './journal-diagnostics-format.js';

/**
 * `summarizeJournalDiagnosticsEntry` の純粋な入出力を固定する（issue
 * #2016）。組み合わせ先（`packages/swr/src/hooks/queries.ts` の
 * `summarizeJournalEntry` / `apps/cli/src/chat.ts` の `summarize`）の歯は
 * それぞれの呼び出し元のテストが持つ——ここは生成元1箇所の判定だけを見る。
 */
describe('summarizeJournalDiagnosticsEntry（issue #2016）', () => {
  it('JOURNAL_DIAGNOSTICS_TYPES はこの4種だけを名乗る', () => {
    expect(JOURNAL_DIAGNOSTICS_TYPES).toEqual([
      'worker_wait',
      'turn_usage',
      'context_usage',
      'inbox_flow',
    ]);
  });

  describe('worker_wait', () => {
    it('待った内訳と、道具を動かしていないターン数を出す', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'worker_wait',
        tasks: 5,
        turns: 41,
        byCause: { input: 1, notification: 3, continuation: 37 },
        toolless: 38,
        settled: true,
      };
      const summary = summarizeJournalDiagnosticsEntry(entry);
      expect(summary).toContain('作業者 5 体を待つあいだに 41 ターン');
      expect(summary).toContain('自己継続 37');
      expect(summary).toContain('道具を1つも動かしていない');
      expect(summary).not.toContain('区間は閉じずに終わった');
    });

    it('settled が false なら「区間は閉じずに終わった」を添える', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'worker_wait',
        tasks: 1,
        turns: 2,
        byCause: { input: 0, notification: 0, continuation: 2 },
        toolless: 0,
        settled: false,
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).toContain('区間は閉じずに終わった');
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

  describe('inbox_flow', () => {
    it('到着/配達/消し込み/滞留の4軸を混ぜずに並べる', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'inbox_flow',
        arrived: { total: 5 },
        delivered: { total: 4 },
        settled: { total: 3 },
        pending: { count: 2, oldestAt: '2026-09-01T00:00:00.000Z' },
      };
      const summary = summarizeJournalDiagnosticsEntry(entry);
      expect(summary).toContain('到着5');
      expect(summary).toContain('配達4');
      expect(summary).toContain('消し込み3');
      expect(summary).toContain('滞留2');
      expect(summary).toContain('（最古 2026-09-01T00:00:00.000Z）');
    });

    it('pending.oldestAt が無ければ「最古」を出さない', () => {
      const entry: JournalDiagnosticsEntryLike = {
        type: 'inbox_flow',
        arrived: { total: 0 },
        delivered: { total: 0 },
        settled: { total: 0 },
        pending: { count: 0 },
      };
      expect(summarizeJournalDiagnosticsEntry(entry)).not.toContain('最古');
    });
  });
});
