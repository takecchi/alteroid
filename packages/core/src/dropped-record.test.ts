import { describe, expect, it } from 'vitest';

import { journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import type { JournalEntryInput } from './schema.js';
import { captureStderr } from './testing.js';

/**
 * 記録を落としたときの跡は stderr にしか出ない。ここで固定するのは2つ —
 * **跡が出ること**と、**その跡に本文が乗らないこと**である。
 *
 * 後者は「うるさいから消す」の反対方向の壊れ方をする。次に読む者が
 * 「情報が足りない」と思って本文を足すと、日誌にすら入らなかった秘密が
 * ホスティング先のログに出る（#52 と同じ形）。
 */
describe('落とした記録の跡', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('本文を出さずに、いつ・どの型か・なぜ失敗したかを残す', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord(
        '日誌',
        journalEntryShape({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[mgr-1] 鍵は ${secret} だった`,
        }),
        new Error('storage is closed'),
      );
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).not.toContain(secret);
    expect(line).toContain('日誌を記録できませんでした');
    expect(line).toContain('exchange with=manager role=inbound');
    expect(line).toContain('storage is closed');
    // 「いつ」。ホスティング先の付ける時刻に頼らない
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
    // 1行で終わる（後続の行を巻き込まない）
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
  });

  it('どの型の自由文も跡に乗らない', () => {
    const entries: JournalEntryInput[] = [
      { type: 'exchange', with: 'human', role: 'inbound', text: secret },
      { type: 'decision', decision: secret, grounds: secret },
      { type: 'escalation', question: secret, approvalId: 'ap-1', managerId: 'mgr-1' },
      { type: 'tool_use', actor: 'manager:mgr-1', tool: 'Bash', input: { command: secret } },
      { type: 'memory_update', slug: 'values', cause: 'clone', summary: secret },
      { type: 'daily_report', date: '2026-08-16', body: secret },
      { type: 'external_event', source: 'github', summary: secret },
    ];

    for (const entry of entries) {
      const shape = journalEntryShape(entry);
      expect(shape, entry.type).not.toContain(secret);
      // 型は必ず分かる（何を落としたのか辿れないと跡の意味が無い）
      expect(shape, entry.type).toContain(entry.type);
    }
  });

  it('理由は1行に切る（ドライバが本文を添えて返してくることがある）', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', '', new Error(`connection lost\nDETAIL: 送った本文 ${secret}`));
    });

    const line = lines[0] as string;
    expect(line).toContain('connection lost');
    expect(line).not.toContain(secret);
  });

  it('長い理由は切り詰める', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', '', new Error('x'.repeat(5000)));
    });

    expect((lines[0] as string).length).toBeLessThan(400);
  });
});
