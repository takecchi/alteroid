import { describe, expect, it } from 'vitest';

import { BOOT_DEFERRED_INDEXES_EVENT_SOURCE, type JournalEntryInput } from '@alteroid/core';

import { createDeferredIndexesReporter, describeDeferredIndexes } from './boot-deferred-indexes.js';

const OUTCOMES = [
  { index: 'journal_human_exchange_seq_idx', state: 'built' as const, ms: 83_200 },
  { index: 'journal_human_replies_idx', state: 'valid' as const, ms: 3 },
  {
    index: 'journal_withdrawals_idx',
    state: 'failed' as const,
    ms: 1_500,
    reason: 'alteroid: 日誌の索引 journal_withdrawals_idx を作れなかった（接続が切れた）',
  },
];

function fakeJournal(fail = false) {
  const appended: JournalEntryInput[] = [];
  return {
    appended,
    journal: {
      append: async (entry: JournalEntryInput) => {
        if (fail) throw new Error('日誌に書けない');
        appended.push(entry);
        return { ...entry, id: 'x', at: '2026-10-24T00:00:00.000Z' } as never;
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('起動の後に作る日誌の索引の結果を、日誌と標準出力に残す', () => {
  it('⭐ 索引ごとに 有効・作った（時間）・作れなかった（時間と理由）を1行に書く', () => {
    expect(describeDeferredIndexes(OUTCOMES)).toBe(
      '起動の後に作る日誌の索引: ' +
        'journal_human_exchange_seq_idx=作った（作り終えるまで 83.2 秒。有効と確かめた）; ' +
        'journal_human_replies_idx=有効（既に在った）; ' +
        'journal_withdrawals_idx=作れなかった（1.5 秒。alteroid: 日誌の索引 journal_withdrawals_idx を作れなかった（接続が切れた））' +
        '。1 本は索引なしで動いている（遅いだけで、答えは変わらない）',
    );
  });

  it('⭐ 日誌を渡す前に届いた結果は預かり、渡したときに external_event として1行書く', async () => {
    const lines: string[] = [];
    const reporter = createDeferredIndexesReporter(
      (text) => lines.push(text),
      () => undefined,
    );
    const { journal, appended } = fakeJournal();

    reporter.note(OUTCOMES);
    expect(lines).toHaveLength(1);
    expect(appended).toEqual([]);

    reporter.attach(journal);
    await settle();

    expect(appended).toEqual([
      {
        type: 'external_event',
        source: BOOT_DEFERRED_INDEXES_EVENT_SOURCE,
        summary: describeDeferredIndexes(OUTCOMES),
      },
    ]);
  });

  it('日誌を渡した後に届いた結果は、その場で書く', async () => {
    const reporter = createDeferredIndexesReporter(
      () => undefined,
      () => undefined,
    );
    const { journal, appended } = fakeJournal();
    reporter.attach(journal);

    reporter.note(OUTCOMES.slice(0, 1));
    await settle();

    expect(appended).toHaveLength(1);
  });

  it('日誌に書けなくても投げず、標準エラーに1行出す', async () => {
    const errors: string[] = [];
    const reporter = createDeferredIndexesReporter(
      () => undefined,
      (text) => errors.push(text),
    );
    reporter.attach(fakeJournal(true).journal);

    reporter.note(OUTCOMES);
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('日誌に書けない');
  });
});
