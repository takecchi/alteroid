import { describe, expect, it } from 'vitest';

import { describeTraceAction } from './trace-action.js';

/**
 * `describeTraceAction`（issue #1528）の歯。
 *
 * **ここが正本の唯一の呼び出し口になった**——`approval-trace.ts`（CLI・
 * クローンの道具）と `apps/web/app/routes/approvals.tsx`（Web UI）が
 * どちらもこの関数を通る（PRD「インターフェース」）。**ここで固定した
 * 文言は、両方の口の出力である。**
 *
 * `tool_use` の `outcome` と `exchange` の接頭辞（issue の実測で Web 側に
 * 無かった2点）は特に個別のケースで固定する——回帰させると Web の複製が
 * また生まれたときと同じ壊れ方（文言のずれ）になる。
 */
describe('describeTraceAction（issue #1528）', () => {
  it('decision: 判断と根拠を1行にする', () => {
    expect(
      describeTraceAction({
        type: 'decision',
        decision: 'b に沿って進めた',
        grounds: '人間の答え',
      }),
    ).toBe('判断: b に沿って進めた（根拠: 人間の答え）');
  });

  it('memory_update: action が無ければ既定 write を出す', () => {
    expect(
      describeTraceAction({
        type: 'memory_update',
        slug: 'foo',
        summary: '要約',
      }),
    ).toBe('記憶の更新 write foo: 要約');
  });

  it('memory_update: action があればそれを出す（write に潰さない）', () => {
    expect(
      describeTraceAction({
        type: 'memory_update',
        action: 'remove',
        slug: 'foo',
        summary: '削除した',
      }),
    ).toBe('記憶の更新 remove foo: 削除した');
  });

  it('tool_use: outcome も input も無ければ道具名だけ', () => {
    expect(describeTraceAction({ type: 'tool_use', tool: 'Bash' })).toBe('道具 Bash');
  });

  it('tool_use: outcome を括弧で足す（Web の複製に無かった欄）', () => {
    expect(describeTraceAction({ type: 'tool_use', tool: 'Bash', outcome: 'failed' })).toBe(
      '道具 Bash（failed）',
    );
    expect(describeTraceAction({ type: 'tool_use', tool: 'Bash', outcome: 'interrupted' })).toBe(
      '道具 Bash（interrupted）',
    );
  });

  it('tool_use: input を JSON にして足す', () => {
    expect(describeTraceAction({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } })).toBe(
      '道具 Bash: {"command":"ls"}',
    );
  });

  it('tool_use: outcome と input が両方あれば両方足す（順序は outcome が先）', () => {
    expect(
      describeTraceAction({
        type: 'tool_use',
        tool: 'Bash',
        outcome: 'failed',
        input: { command: 'ls' },
      }),
    ).toBe('道具 Bash（failed）: {"command":"ls"}');
  });

  it('exchange: with が human なら「人間への返答」（Web の複製に無かった接頭辞）', () => {
    expect(describeTraceAction({ type: 'exchange', with: 'human', text: 'どうぞ' })).toBe(
      '人間への返答: どうぞ',
    );
  });

  it.each([['self'], ['manager']] as const)('exchange: with が %s なら「発言」', (withValue) => {
    expect(describeTraceAction({ type: 'exchange', with: withValue, text: '内部の発言' })).toBe(
      '発言: 内部の発言',
    );
  });

  it('その他の型（4種以外）は type の値をそのまま出す', () => {
    expect(describeTraceAction({ type: 'daily_report' })).toBe('daily_report');
    expect(describeTraceAction({ type: 'escalation' })).toBe('escalation');
  });
});
