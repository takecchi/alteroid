/**
 * `summarizeJournalEntry` の直接テスト。**DOM にも jsdom にも触れない**
 * （素の node 環境で測る。vitest の既定環境）。
 *
 * 2026-08-23 追記の経緯: `virtua`（`routes/journal.tsx` の双方向無限
 * スクロール）を入れる前は、この関数の `daily_report`（`unavailable` の
 * 印つき）・`worker_wait`・`turn_usage` の文言は `journal.test.tsx` が
 * 「画面にその文言が出るか」という DOM 経由の黒箱テストでだけ検証していた。
 * jsdom は virtua の行を1行も描画しないため（`journal.test.tsx` 冒頭の
 * コメント）、それらの DOM テストは期待値を反転せざるを得ず、**この関数
 * 自体の文言の正しさを測る手段が無くなった。** ここへ、関数を直接呼ぶ形で
 * 同じ保証を移設する（`dashboard.tsx` も `summarizeJournalEntry` を DOM で
 * 描いているが、そちらのテストは `decision` しか使っていないので
 * `daily_report`/`worker_wait`/`turn_usage` の文言は元々ここにしか無かった）。
 */
import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '~/lib/types';

import { summarizeJournalEntry } from './queries';

describe('summarizeJournalEntry — daily_report', () => {
  const REASON = "You've hit your org's monthly spend limit";

  it('印の付いた日は「作れなかった」と理由まで言う', () => {
    const entry: JournalEntry = {
      type: 'daily_report',
      id: 'dr-unavailable',
      at: '2026-08-20T22:00:00.000Z',
      date: '2026-08-20',
      body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${REASON}）`,
      unavailable: REASON,
    };
    expect(summarizeJournalEntry(entry)).toBe(`⚠ 2026-08-20 の日報は作れなかった: ${REASON}`);
  });

  it('書けた日はこれまでどおり「N の日報」', () => {
    const entry: JournalEntry = {
      type: 'daily_report',
      id: 'dr-written',
      at: '2026-08-19T22:00:00.000Z',
      date: '2026-08-19',
      body: '進捗があった。',
    };
    expect(summarizeJournalEntry(entry)).toBe('2026-08-19 の日報');
  });
});

describe('summarizeJournalEntry — worker_wait', () => {
  it('空回りが目で分かる文言を含む', () => {
    const entry: JournalEntry = {
      type: 'worker_wait',
      id: 'ww-1',
      at: '2026-08-20T22:10:00.000Z',
      openedAt: '2026-08-20T21:30:00.000Z',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: true,
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).toContain('作業者 5 体を待つあいだに 41 ターン');
    expect(summary).toContain('自己継続 37');
    expect(summary).toContain('道具を1つも動かしていない');
  });
});

describe('summarizeJournalEntry — turn_usage', () => {
  it('cache read/write を潰さない', () => {
    const entry: JournalEntry = {
      type: 'turn_usage',
      id: 'tu-1',
      at: '2026-08-20T22:20:00.000Z',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 120,
          cacheCreationInputTokens: 40,
          webSearchRequests: 0,
          costUsd: 0.5,
        },
      },
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).toContain('read=120');
    expect(summary).toContain('write=40');
  });
});
