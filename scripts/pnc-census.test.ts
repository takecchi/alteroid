import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  analyze,
  classifyTurn,
  parseJournalText,
  renderReport,
  stat,
  verdict,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない集計スクリプト）を読む
} from './pnc-census-core.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));

const BASE = Date.parse('2026-10-27T00:00:00.000Z');
const at = (minutes: number, seconds = 0): string =>
  new Date(BASE + minutes * 60_000 + seconds * 1000).toISOString();

interface Tokens {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

function timing(
  id: string,
  minutes: number,
  triggers: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'turn_timing',
    id,
    at: at(minutes),
    triggers,
    batchSize: triggers.length,
    kinds: ['normal'],
    succeeded: true,
    totalMs: 1000,
    phases: {},
    ...extra,
  };
}

const tok = (cacheRead: number, input = 0, cacheCreation = 0): { tokens: Tokens } => ({
  tokens: { input, cacheRead, cacheCreation, output: 1 },
});

// 手計算の合成データ。値の根拠は各行の右。本文（SECRET-BODY）が出力に出ないことも確かめる。
const ENTRIES: Record<string, unknown>[] = [
  // 人間 2 本（成功）+ 失敗 1 本
  timing('t1', 5, ['human_message'], {
    sdk: { numTurns: 5 },
    ...tok(900_000, 10, 99_990), // C=180,000 / r1=0.9 / r2=1.0 / 文脈 200,000
    contextTokens: 200_000,
    tools: {
      count: 4,
      totalMs: 100,
      top: [
        { name: 'journal_read', count: 2, totalMs: 60, maxMs: 40 },
        { name: 'task_say', count: 2, totalMs: 40, maxMs: 30 },
      ],
    },
  }),
  timing('t11', 55, ['human_message', 'manager_message'], {
    sdk: { numTurns: 3 },
    ...tok(450_000), // 人間へ寄る。C=150,000 / r1=1.0
    contextTokens: 150_000,
  }),
  timing('t9', 45, ['human_message'], { succeeded: false, sdk: { numTurns: 9 }, ...tok(1) }),
  // 報告 3 本（t10 は tokens が無い版）
  timing('t2', 10, ['manager_message'], {
    sdk: { numTurns: 4 },
    ...tok(700_000, 0, 100_000), // C=175,000 / r1=0.875 / r2=1.0
    contextTokens: 200_000,
    tools: {
      count: 2,
      totalMs: 50,
      top: [
        { name: 'manager_report', count: 1, totalMs: 30, maxMs: 30 },
        { name: 'journal_read', count: 1, totalMs: 20, maxMs: 20 },
      ],
    },
  }),
  timing('t3', 15, ['manager_message'], {
    sdk: { numTurns: 2 },
    ...tok(300_000), // C=150,000 / r1=1.0
    contextTokens: 150_000,
    tools: { count: 0, totalMs: 0, top: [] },
  }),
  timing('t10', 50, ['manager_message'], { sdk: { numTurns: 3 }, contextTokens: 100_000 }),
  // 定期・発意（t5 は contextTokens が無い）
  timing('t4', 20, ['timer'], { sdk: { numTurns: 6 }, ...tok(1_080_000), contextTokens: 180_000 }),
  timing('t5', 25, ['self_initiative'], { sdk: { numTurns: 8 }, ...tok(1_200_000) }),
  // 枠の知らせ（直前に runner-registry の external_event）と、ただの外部（sdk 欄が無い版）
  timing('t6', 30, ['external'], { sdk: { numTurns: 2 }, ...tok(400_000), contextTokens: 250_000 }),
  timing('t7', 60, ['external'], { ...tok(100_000), contextTokens: 100_000 }),
  // 蒸留だけのターン（その他）
  timing('t8', 40, ['distill'], { kinds: ['distill'], sdk: { numTurns: 1 }, ...tok(10_000) }),
  {
    type: 'external_event',
    id: 'x1',
    at: at(29, 30),
    source: 'runner-registry',
    summary: 'SECRET-BODY',
  },
  { type: 'external_event', id: 'x2', at: at(70), source: 'github', summary: 'SECRET-BODY' },
  // 要約（clone/session）。u6 はどのターンにも結べない
  {
    type: 'turn_usage',
    id: 'u1',
    at: at(5, 1),
    layer: 'clone',
    site: 'session',
    compactions: [{ trigger: 'auto', preTokens: 267_000, postTokens: 86_000 }],
  },
  {
    type: 'turn_usage',
    id: 'u2',
    at: at(10, 1),
    layer: 'clone',
    site: 'session',
    // 2 本目は postTokens が無い（取れなかった）
    compactions: [
      { trigger: 'auto', preTokens: 260_000, postTokens: 90_000 },
      { trigger: 'manual', preTokens: 100_000 },
    ],
  },
  {
    type: 'turn_usage',
    id: 'u3',
    at: at(20, 1),
    layer: 'clone',
    site: 'session',
    compactions: [{ trigger: 'auto', preTokens: 270_000, postTokens: 82_000 }],
  },
  {
    type: 'turn_usage',
    id: 'u4',
    at: at(5, 2),
    layer: 'manager',
    site: 'session',
    compactions: [{ trigger: 'auto', preTokens: 999_999, postTokens: 999_999 }],
  },
  {
    type: 'turn_usage',
    id: 'u5',
    at: at(40, 1),
    layer: 'clone',
    site: 'distill',
    compactions: [{ trigger: 'auto', preTokens: 5, postTokens: 5 }],
  },
  {
    type: 'turn_usage',
    id: 'u6',
    at: at(300),
    layer: 'clone',
    site: 'session',
    compactions: [{ trigger: 'auto', preTokens: 1, postTokens: 1 }],
  },
  // 増分はあるが要約の無い turn_usage は数えない
  { type: 'turn_usage', id: 'u7', at: at(5, 3), layer: 'clone', site: 'session' },
  // context_usage: c3 は閾値が無い・c3 c4 は messageBreakdown が無い
  {
    type: 'context_usage',
    id: 'c1',
    at: at(4, 59),
    layer: 'clone',
    site: 'session',
    contextUsage: {
      durationMs: 1,
      totalTokens: 200_000,
      autoCompactThreshold: 267_000,
      messageBreakdown: {
        toolCallTokens: 1_000,
        toolResultTokens: 5_000,
        attachmentTokens: 0,
        assistantMessageTokens: 2_000,
        userMessageTokens: 3_000,
        toolsByName: [
          { name: 'journal_read', callTokens: 100, resultTokens: 4_000 },
          { name: 'manager_report', callTokens: 50, resultTokens: 1_000 },
        ],
      },
    },
  },
  {
    type: 'context_usage',
    id: 'c2',
    at: at(9, 59),
    layer: 'clone',
    site: 'session',
    contextUsage: {
      durationMs: 1,
      totalTokens: 200_000,
      autoCompactThreshold: 267_000,
      messageBreakdown: {
        toolCallTokens: 3_000,
        toolResultTokens: 7_000,
        attachmentTokens: 0,
        assistantMessageTokens: 4_000,
        userMessageTokens: 1_000,
        toolsByName: [
          { name: 'journal_read', callTokens: 100, resultTokens: 2_000 },
          { name: 'manager_list', callTokens: 50, resultTokens: 5_000 },
        ],
      },
    },
  },
  {
    type: 'context_usage',
    id: 'c3',
    at: at(14, 59),
    layer: 'clone',
    site: 'session',
    contextUsage: { durationMs: 1, totalTokens: 150_000 },
  },
  {
    type: 'context_usage',
    id: 'c4',
    at: at(19, 59),
    layer: 'clone',
    site: 'session',
    contextUsage: { durationMs: 1, totalTokens: 180_000, autoCompactThreshold: 267_000 },
  },
  // 本文を持つ型は読み飛ばす
  { type: 'exchange', id: 'e1', at: at(6), with: 'human', role: 'inbound', text: 'SECRET-BODY' },
  // 同じ id の重複
  timing('t1', 5, ['human_message'], { sdk: { numTurns: 99 }, ...tok(1) }),
];

const JSONL = [
  ...ENTRIES.map((entry) => JSON.stringify(entry)),
  'これは JSON ではない SECRET-BODY',
  JSON.stringify({ foo: 1 }),
  '',
].join('\n');

describe('stat（中央値・p90・平均。空は null）', () => {
  it('奇数・偶数・p90（最近順位）・空', () => {
    expect(stat([])).toBeNull();
    expect(stat([5, 3])).toEqual({ n: 2, median: 4, p90: 5, mean: 4 });
    expect(stat([4, 2, 3])).toEqual({ n: 3, median: 3, p90: 4, mean: 3 });
    const ten = stat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ten).toEqual({ n: 10, median: 5.5, p90: 9, mean: 5.5 });
  });
});

describe('parseJournalText（受ける形）', () => {
  it('JSONL・封筒・封筒の配列・行の配列を同じ行へ読み、不正な行は数える（捨てて黙らない）', () => {
    const jsonl = parseJournalText(JSONL);
    expect(jsonl.entries).toHaveLength(ENTRIES.length);
    expect(jsonl.badLines).toBe(1);
    expect(jsonl.notEntries).toBe(1);

    const one = ENTRIES[0]!;
    const two = ENTRIES[1]!;
    expect(
      parseJournalText(JSON.stringify({ entries: [one, two], next: null })).entries,
    ).toHaveLength(2);
    expect(
      parseJournalText(JSON.stringify([{ entries: [one] }, { entries: [two] }])).entries,
    ).toHaveLength(2);
    expect(parseJournalText(JSON.stringify([one, two])).entries).toHaveLength(2);
    expect(
      parseJournalText(
        `${JSON.stringify({ entries: [one] })}\n${JSON.stringify({ entries: [two] })}\n`,
      ).entries,
    ).toHaveLength(2);
    expect(parseJournalText('').entries).toEqual([]);
  });
});

describe('classifyTurn（起点の優先順位）', () => {
  it('人間 > 報告 > 外部 > 定期 > 発意、蒸留だけはその他、外部 + 枠の合図は枠の知らせ', () => {
    expect(classifyTurn({ triggers: ['timer', 'manager_message', 'human_answer'] }, false)).toBe(
      'human',
    );
    expect(classifyTurn({ triggers: ['self_initiative', 'manager_message'] }, false)).toBe(
      'report',
    );
    expect(classifyTurn({ triggers: ['timer', 'external'] }, false)).toBe('external');
    expect(classifyTurn({ triggers: ['external'] }, true)).toBe('quota');
    expect(classifyTurn({ triggers: ['self_initiative', 'timer'] }, false)).toBe('timer');
    expect(classifyTurn({ triggers: ['self_initiative'] }, false)).toBe('initiative');
    expect(classifyTurn({ triggers: ['distill'], kinds: ['distill'] }, false)).toBe('other');
    expect(classifyTurn({}, false)).toBe('other');
  });
});

describe('analyze（合成データ。手計算と一致）', () => {
  const reading = parseJournalText(JSONL);
  const report = analyze(reading.entries, reading);

  it('母数・期間・取れなかった件数', () => {
    expect(report.population).toMatchObject({
      turns: 11,
      failed: 1,
      duplicates: 1,
      ignoredTypes: 1,
      badLines: 1,
      notEntries: 1,
      otherLayerRows: 2,
      quotaEvents: 1,
      timingWithoutTime: 0,
    });
    expect(report.period.from).toBe(at(5));
    expect(report.period.to).toBe(at(60));
    expect(report.period.hours).toBeCloseTo(55 / 60, 10);
    expect(report.matching).toEqual({
      usageRows: 4,
      usageUnmatched: 1,
      contextRows: 4,
      contextUnmatched: 0,
    });
  });

  it('人間: N=[5,3]、C=[180,000, 150,000]、文脈、残差、道具の回数（取れなかった 1）', () => {
    const c = report.classes.human;
    expect([c.turns, c.failed]).toEqual([3, 1]);
    expect(c.n).toEqual({ n: 2, median: 4, p90: 5, mean: 4 });
    expect(c.nMissing).toBe(0);
    expect(c.nVsAssumed).toBeCloseTo(4 / 4.6, 10);
    expect(c.c).toEqual({ n: 2, median: 165_000, p90: 180_000, mean: 165_000 });
    expect(c.contextTokens).toMatchObject({ n: 2, median: 175_000 });
    expect(c.r1.median).toBeCloseTo(0.95, 10);
    expect(c.r2.median).toBeCloseTo(1.0, 10);
    expect(c.toolCount).toMatchObject({ n: 1, median: 4 });
    expect(c.toolCountMissing).toBe(1);
    expect(c.post).toMatchObject({ n: 1, median: 86_000 });
  });

  it('報告: tokens が無い行は C・残差の「取れなかった」に数える（0 にしない）', () => {
    const c = report.classes.report;
    expect(c.turns).toBe(3);
    expect(c.n).toEqual({ n: 3, median: 3, p90: 4, mean: 3 });
    expect(c.c).toEqual({ n: 2, median: 162_500, p90: 175_000, mean: 162_500 });
    expect(c.cMissing).toBe(1);
    expect(c.r1.median).toBeCloseTo(0.9375, 10);
    expect(c.residualMissing).toBe(1);
    expect(c.contextTokens.median).toBe(150_000);
    expect(c.post).toMatchObject({ n: 1, median: 90_000 });
    // preTokens は postTokens の無い manual の分も入る
    expect(c.pre).toMatchObject({ n: 2, median: 180_000 });
    expect(c.nVsAssumed).toBeCloseTo(0.75, 10);
  });

  it('定期・発意・外部・枠の知らせ・その他', () => {
    expect(report.classes.timer.n).toMatchObject({ n: 1, median: 6 });
    expect(report.classes.timer.c).toMatchObject({ median: 180_000 });
    expect(report.classes.timer.r1.median).toBeCloseTo(1, 10);
    expect(report.classes.timer.post).toMatchObject({ median: 82_000 });

    const initiative = report.classes.initiative;
    expect(initiative.c).toMatchObject({ median: 150_000 });
    expect(initiative.contextMissing).toBe(1);
    expect(initiative.r1).toBeNull();
    expect(initiative.residualMissing).toBe(1);

    const quota = report.classes.quota;
    expect(quota.turns).toBe(1);
    expect(quota.c).toMatchObject({ median: 200_000 });
    expect(quota.r1.median).toBeCloseTo(0.8, 10);

    const external = report.classes.external;
    expect(external.turns).toBe(1);
    expect(external.n).toBeNull();
    expect(external.nMissing).toBe(1);
    expect(external.cMissing).toBe(1);

    expect(report.classes.other.turns).toBe(1);
    expect(report.classes.other.assumedN).toBeNull();
  });

  it('要約の床 P・直前・閾値（取れなかったは数えて出す）', () => {
    const comp = report.compactions;
    expect(comp).toMatchObject({
      total: 4,
      auto: 3,
      manual: 1,
      triggerUnknown: 0,
      postMissing: 1,
      preMissing: 0,
    });
    expect(comp.post).toEqual({ n: 3, median: 86_000, p90: 90_000, mean: 86_000 });
    expect(comp.pre).toMatchObject({ n: 4, median: 263_500, p90: 270_000 });
    expect(comp.postVsAssumed).toBeCloseTo(1, 10);
    expect(comp.preVsAssumed).toBeCloseTo(263_500 / 267_000, 10);
    expect(report.threshold.stat).toMatchObject({ n: 3, median: 267_000 });
    expect(report.threshold.missing).toBe(1);
    expect(report.threshold.distinct).toEqual([267_000]);
    expect(report.contextTotal).toMatchObject({ n: 4, median: 190_000, mean: 182_500 });
  });

  it('履歴の内訳と道具の回数', () => {
    expect(report.breakdown.rows).toBe(2);
    expect(report.breakdown.means.toolResultTokens).toMatchObject({
      n: 2,
      median: 6_000,
      mean: 6_000,
    });
    expect(report.breakdown.resultByTool).toEqual([
      { name: 'journal_read', meanResultTokens: 3_000 },
      { name: 'manager_list', meanResultTokens: 2_500 },
      { name: 'manager_report', meanResultTokens: 500 },
    ]);
    expect(report.toolsTop).toEqual([
      { name: 'journal_read', count: 3, totalMs: 80 },
      { name: 'task_say', count: 2, totalMs: 40 },
      { name: 'manager_report', count: 1, totalMs: 30 },
    ]);
  });

  it('時刻が読めない turn_timing は集計に入れず数える。欄の型が違う値は「取れなかった」になる', () => {
    const broken = analyze([
      { type: 'turn_timing', id: 'b1', at: 'いつか', triggers: ['timer'], succeeded: true },
      timing('b2', 1, ['timer'], {
        sdk: { numTurns: 'x' },
        tokens: { cacheRead: -1 },
        contextTokens: '1',
      }),
    ]);
    expect(broken.population.timingWithoutTime).toBe(1);
    expect(broken.classes.timer.turns).toBe(1);
    expect(broken.classes.timer.n).toBeNull();
    expect(broken.classes.timer.nMissing).toBe(1);
    expect(broken.classes.timer.contextMissing).toBe(1);
  });

  it('入力が空でも落ちず、母数 0 を出す', () => {
    const empty = analyze([]);
    expect(empty.population.turns).toBe(0);
    expect(empty.period.from).toBeNull();
    expect(renderReport(empty)).toContain('母数: turn_timing 0 ターン');
  });
});

describe('verdict（仮定との判定）', () => {
  it('±25% 以内は概ね一致、外はずれ、無ければ判定不能', () => {
    expect(verdict(1.25)).toContain('概ね一致');
    expect(verdict(0.75)).toContain('概ね一致');
    expect(verdict(0.5)).toBe('ずれ（-50%）');
    expect(verdict(1.5)).toBe('ずれ（+50%）');
    expect(verdict(null)).toBe('判定不能');
  });
});

describe('renderReport（Markdown。本文は出さない）', () => {
  const reading = parseJournalText(JSONL);
  const text: string = renderReport(analyze(reading.entries, reading));

  it('表の見出しと、仮定と並べた列・判定が在る', () => {
    expect(text).toContain('## 起点別: N（要求の本数）と道具の回数');
    expect(text).toContain('## 起点別: C（= cacheRead ÷ N）と、式 cacheRead ≒ N × 文脈 の残差');
    expect(text).toContain('## 要約直後の文脈 P（床）と閾値');
    expect(text).toContain(
      '| 人間 | 3（1） | 2 | 0 | 4.0 | 5.0 | 4.0 | 4.6 | 0.87 | 概ね一致（±25%） |',
    );
    expect(text).toContain(
      '| 床 P（postTokens） | 3 | 1 | 86,000 | 90,000 | 86,000 | 86,000 | 1.00 | 概ね一致（±25%） |',
    );
    expect(text).toContain('| 閾値（context_usage.autoCompactThreshold） | 3 | 1 | 267,000 |');
    expect(text).toContain('JSON として読めなかった行 | 1 |');
    expect(text).toContain('期間: 2026-10-27T00:05:00.000Z 〜 2026-10-27T01:00:00.000Z');
  });

  it('本文・不正な行の中身を出力へ載せない', () => {
    expect(text).not.toContain('SECRET-BODY');
    expect(text).not.toContain('これは JSON ではない');
  });
});

describe('スクリプトの縛り（ネットワーク・env・URL を持たない）', () => {
  for (const file of ['pnc-census-core.mjs', 'pnc-census.mjs', 'pnc-census-README.md']) {
    it(`${file} は URL・ネットワーク・環境変数・鍵を持たない`, () => {
      const source = readFileSync(path.join(DIR, file), 'utf8');
      expect(source).not.toMatch(/https?:\/\//);
      expect(source).not.toMatch(/process\.env|\bfetch\(|node:https?|node:net|node:dns/);
      expect(source).not.toMatch(/secret|password|bearer|api[-_]?key|authorization|ALTEROID_URL/i);
    });
  }
});
