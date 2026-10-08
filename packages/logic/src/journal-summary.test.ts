import { describeGithubCi } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_CI_COUNT_LABEL,
  GITHUB_CI_COUNT_ORDER,
  GITHUB_OPEN_LABEL,
  GITHUB_TRUNCATED_NOTE,
} from './progress-labels.js';
import type { JournalEntry } from './types.js';

import { describeGithubCiText, summarizeJournalEntry } from './journal-summary.js';

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

describe('summarizeJournalEntry — escalation（取り下げ #963）', () => {
  it('withdrawnAt が付いた行は「確認:」ではなく「取り下げ済み:」と言う', () => {
    const entry: JournalEntry = {
      type: 'escalation',
      id: 'esc-withdrawn',
      at: '2026-09-15T00:00:00.000Z',
      question: 'このPRはもうマージされていますか？',
      approvalId: 'ap-1',
      withdrawnAt: '2026-09-15T00:00:00.000Z',
      withdrawnReason: '別経路で判明したので不要になった',
    };
    expect(summarizeJournalEntry(entry)).toBe('取り下げ済み: このPRはもうマージされていますか？');
  });

  it('withdrawnAt が無ければ、これまでどおり回答の有無で言い分ける', () => {
    const asked: JournalEntry = {
      type: 'escalation',
      id: 'esc-asked',
      at: '2026-09-15T00:00:00.000Z',
      question: '進めてよいですか？',
      approvalId: 'ap-2',
    };
    expect(summarizeJournalEntry(asked)).toBe('確認: 進めてよいですか？');

    const answered: JournalEntry = {
      ...asked,
      id: 'esc-answered',
      answeredAt: '2026-09-15T00:05:00.000Z',
      answer: 'よい',
    };
    expect(summarizeJournalEntry(answered)).toBe('回答済: 進めてよいですか？');
  });
});

describe('summarizeJournalEntry — github_observation の CI（#2608）', () => {
  type Ok = Extract<
    Extract<JournalEntry, { type: 'github_observation' }>['result'],
    { status: 'ok' }
  >;
  const observed = (extra: Partial<Ok>): JournalEntry => ({
    type: 'github_observation',
    id: 'gh-1',
    at: '2026-10-02T00:00:00.000Z',
    repo: 'a/b',
    query: 'is:open',
    observedBy: 'clone',
    result: { status: 'ok', openIssues: 3, openPulls: 2, truncated: false, ...extra },
  });
  const cases: [string, Partial<Ok>][] = [
    [
      'ci あり',
      { ci: { pulls: 5, success: 3, failure: 1, pending: 0, checks: '必須チェックだけ' } },
    ],
    [
      'ci あり・打ち切り',
      { ci: { pulls: 2, success: 2, failure: 0, pending: 0, checks: 'x', truncated: true } },
    ],
    ['ciUnavailable', { ciUnavailable: 'HTTP 403' }],
    ['ci も ciUnavailable も無い古い行', {}],
  ];

  it.each(cases)('%s: 要約は core の describeGithubCi と同じ文言を含む', (_label, extra) => {
    const ok = { status: 'ok', openIssues: 3, openPulls: 2, truncated: false, ...extra } as const;
    expect(describeGithubCiText(ok)).toBe(describeGithubCi(ok));
    expect(summarizeJournalEntry(observed(extra))).toBe(
      `a/b: open Issue 3 件 / open PR 2 件（観測者 clone） / ${describeGithubCi(ok)}`,
    );
  });

  it('ciUnavailable の行は、CI を取れなかったことと理由が見える（0 件とは読めない）', () => {
    const line = summarizeJournalEntry(observed({ ciUnavailable: 'HTTP 403' }));
    expect(line).toContain('取れなかった — HTTP 403');
    expect(line).not.toMatch(/success|failure|pending/);
  });

  it('取れなかった回には CI を作らない', () => {
    const failed: JournalEntry = {
      type: 'github_observation',
      id: 'gh-2',
      at: '2026-10-02T00:00:00.000Z',
      repo: 'a/b',
      query: 'is:open',
      observedBy: 'clone',
      result: { status: 'failed', reason: 'HTTP 502' },
    };
    expect(summarizeJournalEntry(failed)).toBe('a/b: 取れなかった（観測者 clone）: HTTP 502');
  });
});

describe('summarizeJournalEntry — conversation_deleted（#4218）', () => {
  it('消した会話の id・件数・主体を1行で言い、本文を持たない', () => {
    const tombstone: JournalEntry = {
      type: 'conversation_deleted',
      id: 'cd-1',
      at: '2026-10-02T00:00:00.000Z',
      deletedConversationId: 'conv-1',
      deletedBy: 'operator',
      hiddenCount: 12,
    };
    expect(summarizeJournalEntry(tombstone)).toBe('会話 conv-1 を削除した（12 件。operator）');
  });
});

describe('summarizeJournalEntry — localized（Web の表示。core の字面は raw のまま）', () => {
  type Ok = Extract<
    Extract<JournalEntry, { type: 'github_observation' }>['result'],
    { status: 'ok' }
  >;
  const observed = (extra: Partial<Ok>): JournalEntry => ({
    type: 'github_observation',
    id: 'gh-1',
    at: '2026-10-02T00:00:00.000Z',
    repo: 'a/b',
    query: 'is:open',
    observedBy: 'clone',
    result: { status: 'ok', openIssues: 3, openPulls: 2, truncated: false, ...extra },
  });
  const cases: [string, Partial<Ok>][] = [
    [
      'ci あり',
      { ci: { pulls: 5, success: 3, failure: 1, pending: 0, checks: '必須チェックだけ' } },
    ],
    [
      'ci あり・打ち切り',
      { ci: { pulls: 2, success: 2, failure: 0, pending: 0, checks: 'x', truncated: true } },
    ],
    ['ciUnavailable', { ciUnavailable: 'HTTP 403' }],
    ['ci も ciUnavailable も無い古い行', {}],
  ];

  it('raw が既定で、字面は変わらない（CLI の TUI が使う）', () => {
    const entry: JournalEntry = {
      type: 'github_observation',
      id: 'gh-3',
      at: '2026-10-02T00:00:00.000Z',
      repo: 'a/b',
      query: 'q',
      observedBy: 'clone',
      result: {
        status: 'ok',
        openIssues: 1,
        openPulls: 1,
        truncated: false,
        ci: { pulls: 1, success: 1, failure: 0, pending: 0, checks: 'x' },
      },
    };
    expect(summarizeJournalEntry(entry)).toBe(summarizeJournalEntry(entry, 'raw'));
    expect(summarizeJournalEntry(entry)).toContain('（観測者 clone）');
    expect(summarizeJournalEntry(entry)).toContain('success 1 / failure 0 / pending 0');
  });

  it.each(cases)('%s: localized は core の原本から表の3語を写しただけ', (_label, extra) => {
    const ok = { status: 'ok', openIssues: 3, openPulls: 2, truncated: false, ...extra } as const;
    let expected = describeGithubCi(ok);
    for (const key of GITHUB_CI_COUNT_ORDER) {
      expected = expected.replace(`${key} `, `${GITHUB_CI_COUNT_LABEL[key]} `);
    }
    expect(describeGithubCiText(ok, 'localized')).toBe(expected);
    const line = summarizeJournalEntry(observed(extra), 'localized');
    expect(line).toBe(
      `a/b: ${GITHUB_OPEN_LABEL.issue.localized} 3 件 / ${GITHUB_OPEN_LABEL.pull.localized} 2 件（記録したのは: クローン） / ${expected}`,
    );
    expect(line).not.toMatch(/clone|success|failure|pending|open|limit/);
    const rawLine = summarizeJournalEntry(observed(extra), 'raw');
    expect(
      rawLine
        .replace(GITHUB_OPEN_LABEL.issue.raw, GITHUB_OPEN_LABEL.issue.localized)
        .replace(GITHUB_OPEN_LABEL.pull.raw, GITHUB_OPEN_LABEL.pull.localized)
        .replace('（観測者 clone）', '（記録したのは: クローン）')
        .replace(describeGithubCi(ok), expected),
    ).toBe(line);
  });

  it('打ち切りの断りは「上限」で出し、raw は limit のまま', () => {
    const entry = observed({ truncated: true });
    expect(summarizeJournalEntry(entry, 'localized')).toContain(GITHUB_TRUNCATED_NOTE.localized);
    expect(summarizeJournalEntry(entry, 'localized')).not.toContain('limit');
    expect(summarizeJournalEntry(entry, 'raw')).toContain('（limit に達した。下限）');
  });

  it('取れなかった回・知らない記録元は識別子を出さない', () => {
    const failed: JournalEntry = {
      type: 'github_observation',
      id: 'gh-4',
      at: '2026-10-02T00:00:00.000Z',
      repo: 'a/b',
      query: 'q',
      observedBy: 'mgr-1',
      result: { status: 'failed', reason: 'HTTP 502' },
    };
    expect(summarizeJournalEntry(failed, 'localized')).toBe(
      'a/b: 取れなかった（記録したのは: クローン以外からの申告）: HTTP 502',
    );
  });
});

describe('summarizeJournalEntry — 添付の控え（#4017）', () => {
  const ref = (id: string, name: string) => ({
    id,
    name,
    mediaType: 'text/plain',
    size: 1,
    sha256: 'a'.repeat(64),
  });

  it('添付だけの発言でも、添付があることと名前が一行に出る', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'x-1',
      at: '2026-10-07T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: '',
      attachments: [ref('a1', 'shot.png')],
    };
    expect(summarizeJournalEntry(entry)).toBe('human ← ［添付 1件: shot.png］');
  });

  it('担い手へ渡した添付と、外部イベントの添付も出る', () => {
    const handed: JournalEntry = {
      type: 'exchange',
      id: 'x-2',
      at: '2026-10-07T00:00:00.000Z',
      with: 'manager',
      role: 'outbound',
      text: '[mgr-1] 見て',
      attachments: [ref('a1', 'shot.png'), ref('a2', 'run.log')],
    };
    expect(summarizeJournalEntry(handed)).toBe(
      'manager → [mgr-1] 見て［添付 2件: shot.png、run.log］',
    );
    const event: JournalEntry = {
      type: 'external_event',
      id: 'x-3',
      at: '2026-10-07T00:00:00.000Z',
      source: 'ci.main',
      summary: 'failure',
      attachments: [ref('a2', 'run.log')],
    };
    expect(summarizeJournalEntry(event)).toBe('ci.main: failure［添付 1件: run.log］');
  });

  it('添付が多いときは先頭の3件の名前だけを出し、残りは件数にする', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'x-6',
      at: '2026-10-07T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: '',
      attachments: ['a', 'b', 'c', 'd', 'e'].map((n) => ref(n, `${n}.txt`)),
    };
    expect(summarizeJournalEntry(entry)).toBe(
      'human ← ［添付 5件: a.txt、b.txt、c.txt、ほか 2 件］',
    );
  });

  it('受け取れなかったファイルだけの報告も、空に見えない', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'x-5',
      at: '2026-10-07T00:00:00.000Z',
      with: 'manager',
      role: 'inbound',
      text: '',
      rejectedAttachments: [{ name: 'big.bin', reason: '大きすぎる' }],
    };
    expect(summarizeJournalEntry(entry)).toBe('manager ← ［受け取れず 1件: big.bin］');
  });

  it('添付の無い行は変わらない', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'x-4',
      at: '2026-10-07T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: 'やあ',
    };
    expect(summarizeJournalEntry(entry)).toBe('human ← やあ');
  });
});
