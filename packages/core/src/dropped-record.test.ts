import { describe, expect, it } from 'vitest';

import { inboxEventShape, journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
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
      {
        type: 'escalation',
        question: secret,
        approvalId: 'ap-1',
        managerId: 'mgr-1',
        answer: secret,
      },
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

  /**
   * **`external_event.source` は「名前」に見えて、外から来る値である。**
   *
   * `POST /events/:source` の URL パスセグメントがそのまま入る（`app.ts` の
   * `source: z.string().min(1)` — 列挙でも長さ上限でもない）。`summary` では
   * ないから安全、と読むと #52 と同じ形が縮小して残る。
   */
  it('external_event の source は外から来る値なので、長さだけにする', () => {
    const shape = journalEntryShape({
      type: 'external_event',
      source: secret,
      summary: 'なんらかの通知',
    });

    expect(shape).not.toContain(secret);
    // 一部でも出さない（先頭64字を切って載せる、も駄目）
    expect(shape).not.toContain(secret.slice(0, 8));
    expect(shape).toContain('external_event');
    expect(shape).toContain(`source.chars=${secret.length}`);
  });

  /**
   * 型によって「長さを出す自由文」と「出さない自由文」が混じると、跡の読み方が
   * 型ごとに変わる。**空だったのか書けなかったのかを、どの型でも同じように
   * 判別できること。**
   */
  it('自由文が2つ以上ある型は、どれの長さかが分かる形で全部出す', () => {
    expect(journalEntryShape({ type: 'decision', decision: 'あ', grounds: 'いう' })).toBe(
      'decision decision.chars=1 grounds.chars=2',
    );
    expect(
      journalEntryShape({
        type: 'escalation',
        approvalId: 'ap-1',
        question: 'あ',
        answer: 'いう',
      }),
    ).toBe('escalation approvalId=ap-1 question.chars=1 answer.chars=2');
    // 未回答なら answer の欄自体が出ない（0 と「まだ無い」を混ぜない）
    expect(
      journalEntryShape({ type: 'escalation', approvalId: 'ap-1', question: 'あ' }),
    ).not.toContain('answer');
    expect(
      journalEntryShape({ type: 'memory_update', slug: 'values', cause: 'clone', summary: 'あ' }),
    ).toContain('chars=1');
  });

  /**
   * `worker_wait` は自由文を1つも持たない — 全フィールドが runner 自身の
   * 数え上げ（整数・真偽値）である。値を決めるのは runner であって外の世界
   * ではないので、`tool_use` の `actor`/`tool` と同じ判定で数値をそのまま
   * 載せてよい（`size()` へ逃がす必要が無い）。
   */
  it('worker_wait は自由文が無いので数値をそのまま載せる', () => {
    const shape = journalEntryShape({
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: false,
    });

    expect(shape).toBe('worker_wait tasks=5 turns=41 toolless=38 settled=false');
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

/**
 * 受信箱が閉じた後に捨てた合図の見分け。
 *
 * ここを通る合図は7種類あり、**人間の発言・webhook の本文・マネージャーの報告が
 * 全部含まれる。** 判定基準は `journalEntryShape` と同じで、「自由文かどうか」
 * ではなく「値を誰が決めるか」である。
 */
describe('捨てた合図の見分け', () => {
  const secret = 'ghp_000000000000000000000000000000000000';
  const at = new Date(0).toISOString();

  it('どの起点でも本文が跡に乗らない（7種類すべて）', () => {
    const events: InboxEvent[] = [
      { type: 'human_message', id: 'e1', at, text: secret, conversationId: secret },
      { type: 'human_answer', id: 'e2', at, approvalId: 'ap-1', answer: secret },
      { type: 'distill', id: 'e3', at, reason: 'shutdown' },
      { type: 'timer', id: 'e4', at, kind: 'daily_report', target: '2026-08-16' },
      { type: 'external', id: 'e5', at, source: secret, payload: { body: secret } },
      { type: 'self_initiative', id: 'e6', at, reason: secret },
      {
        type: 'manager_message',
        id: 'e7',
        at,
        managerId: 'mgr-1',
        kind: 'report',
        text: secret,
        requestId: 'req-1',
      },
    ];

    // 7種類が同じ1行を通る以上、1つでも漏れれば経路ごと漏れる
    expect(events).toHaveLength(7);
    for (const event of events) {
      const shape = inboxEventShape(event);
      expect(shape, event.type).not.toContain(secret);
      // 何を捨てたのか辿れないと跡の意味が無い
      expect(shape, event.type).toContain(event.type);
    }
  });

  /**
   * **`external` の `source` は「名前」に見えて、外から来る値である。**
   * `POST /events/:source` の URL パスセグメントがそのまま入る。
   * `journalEntryShape` の `external_event` とここで判断を変えないこと。
   */
  it('external の source は外から来る値なので長さだけ、payload は有無だけ', () => {
    const shape = inboxEventShape({
      type: 'external',
      id: 'e1',
      at,
      source: secret,
      payload: { token: secret },
    });

    expect(shape).not.toContain(secret);
    // 一部でも出さない（先頭だけ載せる、も駄目）
    expect(shape).not.toContain(secret.slice(0, 8));
    expect(shape).toContain(`source.chars=${secret.length}`);
    expect(shape).toContain('payload=yes');
    // 中身が無い通知と区別が付く
    expect(inboxEventShape({ type: 'external', id: 'e2', at, source: 'github' })).toContain(
      'payload=none',
    );
  });

  it('誰から届いたかは残る（マネージャーの報告を突き合わせるため）', () => {
    expect(
      inboxEventShape({
        type: 'manager_message',
        id: 'e1',
        at,
        managerId: 'mgr-ff1a6c32',
        kind: 'report',
        text: 'あ',
      }),
    ).toBe('manager_message managerId=mgr-ff1a6c32 kind=report chars=1');
    // 返事待ちで止まっている1件かどうかも分かる
    expect(
      inboxEventShape({
        type: 'manager_message',
        id: 'e2',
        at,
        managerId: 'mgr-1',
        kind: 'question',
        text: 'あ',
        requestId: 'req-9',
      }),
    ).toContain('requestId=req-9');
  });
});
