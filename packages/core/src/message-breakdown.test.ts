import { describe, expect, it } from 'vitest';

import {
  describeMessageBreakdown,
  foldMessageBreakdown,
  MESSAGE_BREAKDOWN_TOOL_OTHER,
  MESSAGE_BREAKDOWN_TOOLS_LIMIT,
} from './message-breakdown.js';
import { contextUsageObservationSchema } from './schema.js';

const totals = {
  toolCallTokens: 1,
  toolResultTokens: 2,
  attachmentTokens: 3,
  assistantMessageTokens: 4,
  userMessageTokens: 5,
};

describe('foldMessageBreakdown（会話の履歴の内訳を日誌用に畳む）', () => {
  it('SDK が欄を返さなかった回は undefined（呼び出し側が欄を作らない）', () => {
    expect(foldMessageBreakdown(undefined)).toBeUndefined();
  });

  it('5つの合計をそのまま写し、道具ごとの行を結果のトークンの大きい順に並べる', () => {
    expect(
      foldMessageBreakdown({
        ...totals,
        toolCallsByType: [
          { name: 'Read', callTokens: 10, resultTokens: 100 },
          { name: 'Bash', callTokens: 20, resultTokens: 900 },
        ],
      }),
    ).toEqual({
      ...totals,
      toolsByName: [
        { name: 'Bash', callTokens: 20, resultTokens: 900 },
        { name: 'Read', callTokens: 10, resultTokens: 100 },
      ],
    });
  });

  it('道具の行が無くても欄は作る（SDK は内訳を返しており、その中身が空だっただけ）', () => {
    expect(foldMessageBreakdown({ ...totals, toolCallsByType: [] })).toEqual({
      ...totals,
      toolsByName: [],
    });
  });

  it('同じ結果のトークンの行は名前の順で、入力の順に依存しない', () => {
    const rows = [
      { name: 'b', callTokens: 1, resultTokens: 5 },
      { name: 'a', callTokens: 1, resultTokens: 5 },
    ];
    const forward = foldMessageBreakdown({ ...totals, toolCallsByType: rows });
    const backward = foldMessageBreakdown({ ...totals, toolCallsByType: [...rows].reverse() });
    expect(forward).toEqual(backward);
    expect(forward?.toolsByName.map((row) => row.name)).toEqual(['a', 'b']);
  });

  it('同じ名前の行は合算する', () => {
    const folded = foldMessageBreakdown({
      ...totals,
      toolCallsByType: [
        { name: 'Read', callTokens: 1, resultTokens: 10 },
        { name: 'Read', callTokens: 2, resultTokens: 20 },
      ],
    });
    expect(folded?.toolsByName).toEqual([{ name: 'Read', callTokens: 3, resultTokens: 30 }]);
  });

  it('上限以内なら「ほか」の行を作らない', () => {
    const folded = foldMessageBreakdown({
      ...totals,
      toolCallsByType: Array.from({ length: MESSAGE_BREAKDOWN_TOOLS_LIMIT }, (_, i) => ({
        name: `t${String(i).padStart(2, '0')}`,
        callTokens: 1,
        resultTokens: i + 1,
      })),
    });
    expect(folded?.toolsByName).toHaveLength(MESSAGE_BREAKDOWN_TOOLS_LIMIT);
    expect(folded?.toolsByName.some((row) => row.name === MESSAGE_BREAKDOWN_TOOL_OTHER)).toBe(
      false,
    );
  });

  it('上限（12）を超えた分は「ほか」の1行へ合算し、行数は上限に収まり、合計は変わらない', () => {
    // 20 種類、t00（結果 1）〜 t19（結果 20）。呼び出しは各 2。
    const folded = foldMessageBreakdown({
      ...totals,
      toolCallsByType: Array.from({ length: 20 }, (_, i) => ({
        name: `t${String(i).padStart(2, '0')}`,
        callTokens: 2,
        resultTokens: i + 1,
      })),
    });
    const rows = folded?.toolsByName ?? [];
    expect(MESSAGE_BREAKDOWN_TOOLS_LIMIT).toBe(12);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ name: 't19', callTokens: 2, resultTokens: 20 });
    // 上位 11 行（t19..t09）を除いた t08..t00 の 9 種類 = 結果 9+8+…+1
    expect(rows[11]).toEqual({
      name: MESSAGE_BREAKDOWN_TOOL_OTHER,
      callTokens: 18,
      resultTokens: 45,
    });
    expect(rows.reduce((t, r) => t + r.resultTokens, 0)).toBe(210);
    expect(rows.reduce((t, r) => t + r.callTokens, 0)).toBe(40);
  });
});

describe('contextUsageObservationSchema の messageBreakdown', () => {
  it('この欄が無い古い行をそのまま読める', () => {
    const old = { durationMs: 5, totalTokens: 100, mcpToolTokens: 10, mcpToolCount: 2 };
    expect(contextUsageObservationSchema.parse(old)).toEqual(old);
  });

  it('新しい欄を持つ行を読み、中身を落とさない', () => {
    const row = {
      durationMs: 5,
      messageBreakdown: {
        ...totals,
        toolsByName: [{ name: 'Bash', callTokens: 20, resultTokens: 900 }],
      },
    };
    expect(contextUsageObservationSchema.parse(row)).toEqual(row);
  });
});

describe('describeMessageBreakdown（人が読む1行）', () => {
  it('結果が大きい上位3道具だけを名前と数で出す', () => {
    const line = describeMessageBreakdown({
      ...totals,
      toolsByName: [
        { name: 'a', callTokens: 1, resultTokens: 4_000 },
        { name: 'b', callTokens: 1, resultTokens: 3_000 },
        { name: 'c', callTokens: 1, resultTokens: 2_000 },
        { name: 'd', callTokens: 1, resultTokens: 1_000 },
      ],
    });
    expect(line).toContain('結果が大きい道具: a 4,000・b 3,000・c 2,000');
    expect(line).not.toContain('d 1,000');
    expect(line).not.toContain('\n');
  });

  it('道具の行が無ければ上位の文は書かない', () => {
    expect(describeMessageBreakdown({ ...totals, toolsByName: [] })).not.toContain(
      '結果が大きい道具',
    );
  });
});
