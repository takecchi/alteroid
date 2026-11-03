import type { JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { summarizeJournalEntry } from './journal-summary.js';

// 承認（escalation）の状態を見る判定の、いまの端の振る舞いを固定する（現状の挙動を固定。まとめる PR で見直す）。
// 本番コードは変えない。ここは `!== undefined` で見る（CLI の `approvalText` は真偽、Web は null も立っていないと読む）。

const AT = '2026-10-06T10:03:00.000Z';

function entry(over: Record<string, unknown>): JournalEntry {
  return {
    type: 'escalation',
    id: 'esc',
    at: AT,
    question: 'q',
    approvalId: 'ap-1',
    ...over,
  } as JournalEntry;
}

describe('journal-summary.ts の escalation の状態（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('組み合わせ: 両方立った行は「取り下げ済み」（取り下げが先）', () => {
    expect({
      neither: summarizeJournalEntry(entry({})),
      answered: summarizeJournalEntry(entry({ answeredAt: AT, answer: 'a' })),
      withdrawn: summarizeJournalEntry(entry({ withdrawnAt: AT })),
      both: summarizeJournalEntry(entry({ answeredAt: AT, answer: 'a', withdrawnAt: AT })),
    }).toEqual({
      neither: '確認: q',
      answered: '回答済: q',
      withdrawn: '取り下げ済み: q',
      both: '取り下げ済み: q',
    });
  });

  it('⚠ 空文字は「立っている」と読む（`!== undefined`。CLI の真偽判定は立っていないと読む）', () => {
    expect(summarizeJournalEntry(entry({ withdrawnAt: '' }))).toBe('取り下げ済み: q');
    expect(summarizeJournalEntry(entry({ answeredAt: '' }))).toBe('回答済: q');
  });
});
