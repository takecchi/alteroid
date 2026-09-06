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

describe('summarizeJournalEntry — memory_update', () => {
  it('action と前後バイト数を出す（新形式）', () => {
    const entry: JournalEntry = {
      type: 'memory_update',
      id: 'mu-new',
      at: '2026-08-23T10:00:00.000Z',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: 12,
      bytesAfter: 34,
      summary: '価値観を書いた',
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).toContain('write');
    expect(summary).toContain('12→34 バイト');
  });

  it('bytesBefore が実際に0のときは「不明」ではなく 0 をそのまま出す（新規作成）', () => {
    const entry: JournalEntry = {
      type: 'memory_update',
      id: 'mu-created',
      at: '2026-08-23T10:00:00.000Z',
      slug: 'new-doc',
      cause: 'clone',
      action: 'write',
      bytesBefore: 0,
      bytesAfter: 34,
      summary: '新規作成',
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).toContain('0→34 バイト');
    expect(summary).not.toContain('不明');
  });

  it('action / バイト数を持たない古いエントリは「不明」と明示し、0 とは出さない', () => {
    const entry: JournalEntry = {
      type: 'memory_update',
      id: 'mu-old',
      at: '2026-08-19T10:00:00.000Z',
      slug: 'values',
      cause: 'human',
      summary: '昔の更新',
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).not.toMatch(/[^→]0 バイト/);
    expect(summary).not.toContain('0→0 バイト');
    expect(summary).toContain('不明');
  });

  it('バイト数（機械可読）と summary に埋め込まれた文字数（自由文）が同じ節に混在しない', () => {
    // memory_delete の summary は「（削除直前 N 文字）」を埋め込む
    // （tools.ts の memory_delete）。この関数が新しく足すバイトの注記は
    // 構造化された括弧の中に置き、自由文の summary はコロンの後ろへ分ける。
    const entry: JournalEntry = {
      type: 'memory_update',
      id: 'mu-delete',
      at: '2026-08-23T10:00:00.000Z',
      slug: 'temp-note',
      cause: 'clone',
      action: 'remove',
      bytesBefore: 42,
      bytesAfter: 0,
      summary: '片付け（削除直前 40 文字）',
    };
    const summary = summarizeJournalEntry(entry);
    const beforeColon = summary.slice(0, summary.indexOf(': '));
    const afterColon = summary.slice(summary.indexOf(': ') + 2);
    // バイトの注記（構造化）はコロンより前、文字数を含む自由文はコロンより後。
    expect(beforeColon).toContain('42→0 バイト');
    expect(beforeColon).not.toContain('文字');
    expect(afterColon).toContain('40 文字');
    expect(afterColon).not.toContain('バイト');
  });
});

describe('summarizeJournalEntry — subagent_stall', () => {
  it('outcome=woken は「起こし直した」を含み、wakeupCount を出す', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'ss-woken',
      at: '2026-09-06T10:00:00.000Z',
      agentId: 'agent-1',
      agentType: 'Explore',
      ownedTaskCount: 3,
      sessionTaskCount: 7,
      wakeupCount: 2,
      outcome: 'woken',
      text: 'SubagentStop（作業者: Explore / agent_id=agent-1）: 背景処理が3件残ったまま畳もうとした。起こし直した（2回目 / 上限 5）。',
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).toContain('起こし直した');
    expect(summary).toContain('2回目');
    expect(summary).not.toContain('要対応');
  });

  it('outcome=limit_reached は「起こし直さなかった」「要対応」を含む（`woken` と2値を潰さない）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'ss-limit',
      at: '2026-09-06T10:05:00.000Z',
      agentId: 'agent-2',
      agentType: 'general-purpose',
      ownedTaskCount: 1,
      sessionTaskCount: 4,
      wakeupCount: 5,
      outcome: 'limit_reached',
      text: 'SubagentStop（作業者: general-purpose / agent_id=agent-2）: 上限（5回）に達したため、起こし直さなかった。',
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).toContain('起こし直さなかった');
    expect(summary).toContain('要対応');
    expect(summary).not.toContain('undefined');
  });

  it('agentType が無い（undefined）ときは文字列に "undefined" を出さない', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'ss-no-agent-type',
      at: '2026-09-06T10:10:00.000Z',
      agentId: 'agent-3',
      ownedTaskCount: 2,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: 'SubagentStop（作業者: (不明) / agent_id=agent-3）: 背景処理が2件残ったまま畳もうとした。起こし直した（1回目 / 上限 5）。',
    };
    const summary = summarizeJournalEntry(entry);
    expect(summary).not.toContain('undefined');
    expect(summary).toContain('agent-3');
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
