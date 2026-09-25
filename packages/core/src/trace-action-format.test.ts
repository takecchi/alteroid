import { describe, expect, it } from 'vitest';

import { describeTraceAction } from './trace-action-format.js';

/**
 * `describeTraceAction` の正本を pin する（issue #1528）。
 *
 * **ここが「揃える」の実体である。** `apps/web/app/routes/approvals.tsx` は
 * もうこの関数をそのまま呼ぶだけなので、ここで固定した文言がそのまま画面に
 * 出る（`apps/web/app/routes/approvals.test.tsx` の「13種の entry すべてで、
 * 画面の表示が core の正本と一致する」は、この関数の出力と画面の表示が
 * 食い違っていないかだけを見る——文言そのものの正本はここに在る）。
 */
describe('describeTraceAction', () => {
  it('decision: 判断と根拠を1文にする', () => {
    expect(
      describeTraceAction({
        type: 'decision',
        decision: 'b に沿って進めた',
        grounds: '人間の答え',
      }),
    ).toBe('判断: b に沿って進めた（根拠: 人間の答え）');
  });

  it('memory_update: action が在ればそれを、無ければ write を出す', () => {
    expect(
      describeTraceAction({
        type: 'memory_update',
        action: 'remove',
        slug: 'old-note',
        summary: '削除直前120文字',
      }),
    ).toBe('記憶の更新 remove old-note: 削除直前120文字');
    expect(describeTraceAction({ type: 'memory_update', slug: 'note', summary: '書いた' })).toBe(
      '記憶の更新 write note: 書いた',
    );
  });

  it('tool_use: outcome が在れば括弧で足す。無ければ足さない', () => {
    expect(describeTraceAction({ type: 'tool_use', tool: 'journal_write' })).toBe(
      '道具 journal_write',
    );
    expect(
      describeTraceAction({ type: 'tool_use', tool: 'journal_write', outcome: 'failed' }),
    ).toBe('道具 journal_write（failed）');
    expect(
      describeTraceAction({ type: 'tool_use', tool: 'journal_write', outcome: 'interrupted' }),
    ).toBe('道具 journal_write（interrupted）');
  });

  it('tool_use: input が在れば JSON にして足す（outcome と両方でも順序は固定）', () => {
    expect(
      describeTraceAction({
        type: 'tool_use',
        tool: 'journal_write',
        outcome: 'failed',
        input: { slug: 'note' },
      }),
    ).toBe('道具 journal_write（failed）: {"slug":"note"}');
    expect(
      describeTraceAction({ type: 'tool_use', tool: 'journal_write', input: { slug: 'note' } }),
    ).toBe('道具 journal_write: {"slug":"note"}');
  });

  it('exchange: with が human なら「人間への返答」、それ以外（manager / self）は「発言」', () => {
    expect(describeTraceAction({ type: 'exchange', with: 'human', text: '続けます' })).toBe(
      '人間への返答: 続けます',
    );
    expect(describeTraceAction({ type: 'exchange', with: 'self', text: '内部メモ' })).toBe(
      '発言: 内部メモ',
    );
    expect(describeTraceAction({ type: 'exchange', with: 'manager', text: '委譲の返答' })).toBe(
      '発言: 委譲の返答',
    );
  });

  /**
   * **残り9種類（`decision` / `memory_update` / `tool_use` / `exchange` の外）
   * は、解釈を足さず `entry.type` をそのまま返す。** 一般化した「基準」を
   * ここで作らない（`approval-trace.ts` 冒頭の doc）ので、これらは日誌の
   * 行の中身を読まない——`journalEntrySchema` に新しい種類が増えても、
   * この関数はその種類の名前を返すだけで正しく動き続ける。
   */
  it.each([
    'token_rotation',
    'subagent_stall',
    'escalation',
    'daily_report',
    'external_event',
    'worker_wait',
    'turn_usage',
    'context_usage',
    'inbox_flow',
  ] as const)('%s: 解釈を足さず type をそのまま返す', (type) => {
    expect(describeTraceAction({ type })).toBe(type);
  });
});
