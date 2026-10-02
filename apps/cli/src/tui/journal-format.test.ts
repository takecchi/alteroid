import { describe, expect, it } from 'vitest';

import { journalEntry, minute, said } from './fake-api.js';
import {
  JOURNAL_TYPES,
  filterText,
  formatDateTime,
  journalDetailText,
  journalEmptyMessage,
  journalListLine,
  oneLine,
  summarizeJournalEntry,
} from './journal-format.js';
import { JOURNAL_DETAIL_CHARS } from './journal-window.js';

const at = minute(0);

describe('要旨（Web の summarizeJournalEntry と同じ文言）', () => {
  it('種別ごとの 1 行', () => {
    const cases: [ReturnType<typeof journalEntry>, string][] = [
      [said(1, 'こんにちは'), 'human ← こんにちは'],
      [
        journalEntry('x', 'exchange', at, { with: 'manager', role: 'outbound', text: 'どうぞ' }),
        'manager → どうぞ',
      ],
      [
        journalEntry('x', 'decision', at, { decision: '進める', grounds: '前例' }),
        '進める（根拠: 前例）',
      ],
      [journalEntry('x', 'escalation', at, { question: '良いか' }), '確認: 良いか'],
      [
        journalEntry('x', 'escalation', at, { question: '良いか', answeredAt: at }),
        '回答済: 良いか',
      ],
      [
        journalEntry('x', 'escalation', at, { question: '良いか', withdrawnAt: at }),
        '取り下げ済み: 良いか',
      ],
      [journalEntry('x', 'tool_use', at, { actor: 'clone', tool: 'Bash' }), 'clone が Bash'],
      [
        journalEntry('x', 'memory_update', at, {
          slug: 'a',
          cause: 'human',
          action: 'write',
          bytesBefore: 1,
          bytesAfter: 5,
          summary: '更新した',
        }),
        '記憶 a を更新（human/write / 1→5 バイト）: 更新した',
      ],
      [
        journalEntry('x', 'memory_update', at, { slug: 'a', cause: 'human', summary: 's' }),
        '記憶 a を更新（human / 前後バイト数不明（旧形式））: s',
      ],
      [journalEntry('x', 'daily_report', at, { date: '2026-10-01' }), '2026-10-01 の日報'],
      [
        journalEntry('x', 'daily_report', at, { date: '2026-10-01', unavailable: '書けない' }),
        '⚠ 2026-10-01 の日報は作れなかった: 書けない',
      ],
      [journalEntry('x', 'external_event', at, { source: 'gh', summary: 'PR' }), 'gh: PR'],
      [
        journalEntry('x', 'token_rotation', at, { event: 'exhausted', text: '全層が止まる' }),
        '[exhausted] 全層が止まる',
      ],
    ];
    for (const [entry, expected] of cases) expect(summarizeJournalEntry(entry)).toBe(expected);
  });

  it('量の多い診断 4 種は空欄にならない（CLI /journal と同じ共有の口）', () => {
    const fixtures = [
      journalEntry('x', 'worker_wait', at, {
        tasks: 2,
        turns: 3,
        byCause: { input: 0, notification: 2, continuation: 1 },
        toolless: 1,
        settled: true,
      }),
      journalEntry('x', 'turn_usage', at, {
        layer: 'clone',
        site: 'chat',
        managerId: 'm',
        models: { opus: { costUsd: 0.5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } },
      }),
      journalEntry('x', 'context_usage', at, {
        layer: 'clone',
        site: 'chat',
        managerId: 'm',
        turnSucceeded: true,
        contextUsage: { percentage: 40, totalTokens: 1000 },
      }),
      journalEntry('x', 'inbox_flow', at, {
        arrived: { total: 1 },
        delivered: { total: 1 },
        settled: { total: 0 },
        pending: { count: 2 },
      }),
    ];
    for (const entry of fixtures) {
      expect(summarizeJournalEntry(entry).length).toBeGreaterThan(5);
      expect(summarizeJournalEntry(entry)).not.toContain('要旨を作れなかった');
    }
  });

  it('欄の形が合わない行でも落ちない（要旨を作れなかったと言う）', () => {
    expect(summarizeJournalEntry(journalEntry('x', 'turn_usage', at, {}))).toContain(
      '要旨を作れなかった',
    );
  });

  it('知らない種別は落とさず、種別だけ言う', () => {
    expect(summarizeJournalEntry(journalEntry('x', 'future_kind' as never, at))).toContain(
      'future_kind',
    );
  });

  it('絞り込みの選択肢は 13 種すべて（Web のチップと同じ並び）', () => {
    expect(JOURNAL_TYPES).toEqual([
      'exchange',
      'decision',
      'escalation',
      'tool_use',
      'memory_update',
      'daily_report',
      'external_event',
      'worker_wait',
      'turn_usage',
      'context_usage',
      'token_rotation',
      'subagent_stall',
      'inbox_flow',
    ]);
  });
});

describe('一覧の 1 行と文言', () => {
  it('時刻・種別・要旨が 1 行で、改行は潰し、長い本文は切る', () => {
    const line = journalListLine(
      said(1, `一行目\n二行目${'あ'.repeat(1000)}`),
      Date.parse(minute(5)),
    );
    expect(line).toContain('[exchange]');
    expect(line).toContain('human ← 一行目 二行目');
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(400);
    expect(line.endsWith('…')).toBe(true);
  });

  it('時刻は今年なら年を足さず、今年でなければ足す', () => {
    const now = Date.parse('2026-10-02T00:00:00.000Z');
    expect(formatDateTime('2026-09-29T07:00:00.000Z', now)).not.toContain('2026');
    expect(formatDateTime('2025-09-29T07:00:00.000Z', now)).toContain('2025');
    expect(formatDateTime('壊れた', now)).toBe('壊れた');
  });

  it('絞った 0 件を、絞っていない 0 件と同じ文言にしない', () => {
    expect(journalEmptyMessage([], '')).toBe('この条件では何も記録されていない。');
    expect(journalEmptyMessage(['decision'], '')).toContain('type=decision');
    expect(journalEmptyMessage(['decision'], '')).toContain('絞り込みを外せば');
    expect(journalEmptyMessage([], '語')).toContain('「語」に当たる記録は無い（この条件の中では）');
    expect(journalEmptyMessage(['decision', 'exchange'], '語')).toContain(
      'type=decision,exchange に絞った上で',
    );
    expect(filterText([], '')).toBe('すべて');
    expect(filterText(['decision'], '語')).toBe('type=decision 「語」');
  });

  it('oneLine は空白を潰して切る', () => {
    expect(oneLine('a \n  b', 10)).toBe('a b');
    expect(oneLine('abcdef', 3)).toBe('abc…');
  });
});

describe('詳細の本文', () => {
  it('欄ごとに並べ、文字列の改行は保つ。type・id・at は頭に出すので本文には出さない', () => {
    const text = journalDetailText(said(1, '一行目\n二行目'));
    expect(text).toContain('text:\n  一行目\n  二行目');
    expect(text).toContain('with: human');
    expect(text).not.toContain('id:');
    expect(text).not.toMatch(/^type:/m);
  });

  it('入れ子の値は JSON で字下げして出す', () => {
    const text = journalDetailText(
      journalEntry('x', 'tool_use', at, { actor: 'a', tool: 'b', input: { k: [1, 2] } }),
    );
    expect(text).toContain('input:\n  {\n    "k": [');
  });

  it('文字数の予算を超えたら、省いた字数を言う', () => {
    const text = journalDetailText(said(1, 'あ'.repeat(JOURNAL_DETAIL_CHARS * 2)));
    expect(text).toContain('字のうち先頭');
    expect(text.length).toBeLessThan(JOURNAL_DETAIL_CHARS + 200);
  });
});
