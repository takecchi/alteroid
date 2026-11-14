import { describe, expect, it } from 'vitest';

import { parseJournalJsonl } from './diagnostics-analysis.js';
import {
  DIAGNOSTICS_SUMMARY_MAX_BYTES,
  DiagnosticsSummarySecretError,
  buildDiagnosticsSummary,
  diagnosticsSummarySchema,
  findSecretPatterns,
  jsonByteLength,
  type DiagnosticsSummary,
} from './diagnostics-summary.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');

type Row = Record<string, unknown>;
const journalOf = (rows: Row[]) => parseJournalJsonl(rows.map((r) => JSON.stringify(r)).join('\n'));

const model = (cacheRead: number, cacheCreation: number, input = 0, output = 0) => ({
  opus: {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    webSearchRequests: 0,
    costUsd: 0,
  },
});

const turnUsage = (at: string, managerId: unknown, models: unknown, extra: Row = {}): Row => ({
  type: 'turn_usage',
  id: `u-${at}-${String(managerId).length}`,
  at,
  layer: 'clone',
  site: 'session',
  managerId,
  models,
  ...extra,
});

const turnTiming = (at: string, triggers: unknown, tokens: unknown, extra: Row = {}): Row => ({
  type: 'turn_timing',
  id: `t-${at}`,
  at,
  triggers,
  batchSize: 1,
  succeeded: true,
  totalMs: 1000,
  ...(tokens === undefined ? {} : { tokens }),
  ...extra,
});

const build = (rows: Row[], usage?: unknown, topN?: number): DiagnosticsSummary =>
  buildDiagnosticsSummary(
    { journal: journalOf(rows), usage },
    { now: NOW, ...(topN === undefined ? {} : { topN }) },
  );

// 手計算の入力
// turn_usage（clone/session）: mgr-a 300/100 と 100/100、mgr-b 50/50（cache read / creation）。input は 10・10・0
//   overall: read 450、creation 250 → 450/250 = 1.8。読み出し率 = 450 / (20 + 450 + 250) = 0.625
//   mgr-a の cache read は 400 で上位 1 位
// turn_timing: 1 件目 manager_message（read 90 / creation 10 / input 1）、2 件目 manager_message + timer（10 / 10 / 1）
//   read 合計 100、creation 合計 20 → 5。起点 timer の割合は 10 / 100。両者の開始（at − totalMs）は 30 秒差
const HAND_ROWS: Row[] = [
  turnUsage('2026-11-01T00:00:00.000Z', 'mgr-a', model(300, 100, 10)),
  turnUsage('2026-11-01T00:05:00.000Z', 'mgr-a', model(100, 100, 10)),
  turnUsage('2026-11-01T00:06:00.000Z', 'mgr-b', model(50, 50, 0)),
  turnTiming('2026-11-01T00:10:00.000Z', ['manager_message'], {
    input: 1,
    cacheRead: 90,
    cacheCreation: 10,
    output: 2,
  }),
  turnTiming('2026-11-01T00:10:30.000Z', ['manager_message', 'timer'], {
    input: 1,
    cacheRead: 10,
    cacheCreation: 10,
    output: 2,
  }),
  {
    type: 'context_usage',
    id: 'c1',
    at: '2026-11-01T01:00:00.000Z',
    layer: 'clone',
    site: 'session',
    managerId: 'mgr-a',
    contextUsage: {
      systemPromptTokens: 100,
      memoryFileTokens: 200,
      mcpToolTokens: 300,
      totalTokens: 1000,
      mcpToolsByServer: [{ name: 'alteroid-manager', tokens: 40 }],
    },
  },
  {
    type: 'context_usage',
    id: 'c2',
    at: '2026-11-01T02:00:00.000Z',
    layer: 'clone',
    site: 'session',
    managerId: 'mgr-a',
    contextUsage: {
      systemPromptTokens: 300,
      memoryFileTokens: 200,
      mcpToolTokens: 500,
      totalTokens: 3000,
      mcpToolsByServer: [{ name: 'alteroid-manager', tokens: 60 }],
    },
  },
];

describe('buildDiagnosticsSummary: 手計算と一致する', () => {
  const s = build(HAND_ROWS);

  it('キャッシュ（read÷creation・読み出し率。出所ごと）', () => {
    expect(s.cache.fromTurnUsage.overall.readOverCreation.value).toBeCloseTo(1.8, 10);
    expect(s.cache.fromTurnUsage.overall.readRate.value).toBeCloseTo(0.625, 10);
    expect(s.cache.fromTurnUsage.overall).toMatchObject({
      rows: 3,
      cacheReadSum: 450,
      cacheCreationSum: 250,
    });
    expect(s.cache.fromTurnUsage.byLayer.map((e) => e.layer)).toEqual(['clone']);
    expect(s.cache.fromTurnUsage.bySite.map((e) => e.site)).toEqual(['session']);
    expect(s.cache.fromTurnTiming.readOverCreation.value).toBeCloseTo(5, 10);
    expect(s.cache.fromTurnTiming.readRate.value).toBeCloseTo(100 / 122, 10);
  });

  it('起点・間隔・上位の委譲・プロンプトの大きさ', () => {
    expect(s.triggers.byKind).toEqual([
      { kind: 'manager_message', turns: 2, cacheReadSum: 100, share: 1 },
      { kind: 'timer', turns: 1, cacheReadSum: 10, share: 0.1 },
    ]);
    expect(s.triggers.managerMessageIntervals).toMatchObject({
      turns: 2,
      intervals: 1,
      under60s: { count: 1, share: 1 },
    });
    expect(s.perTurn.topManagers.rows).toEqual([
      { managerId: 'mgr-a', layer: 'clone', turns: 2, cacheRead: 400 },
      { managerId: 'mgr-b', layer: 'clone', turns: 1, cacheRead: 50 },
    ]);
    expect(s.promptSize.days).toHaveLength(1);
    expect(s.promptSize.days[0]).toMatchObject({
      day: '2026-11-01',
      rows: 2,
      systemPromptTokens: { median: 200, max: 300, missingRows: 0 },
      totalTokens: { median: 2000, max: 3000, missingRows: 0 },
    });
    expect(s.promptSize.mcpServers.rows).toEqual([
      { name: 'alteroid-manager', observations: 2, medianTokens: 50, maxTokens: 60 },
    ]);
  });

  it('期間・行数・型ごとの件数・生成時刻・版', () => {
    expect(s.schemaVersion).toBe(1);
    expect(s.generatedAt).toBe(NOW.toISOString());
    expect(s.period).toEqual({
      start: '2026-11-01T00:00:00.000Z',
      end: '2026-11-01T02:00:00.000Z',
    });
    expect(s.rows.lines).toBe(7);
    expect(s.rows.byType).toEqual([
      { type: 'context_usage', count: 2 },
      { type: 'turn_timing', count: 2 },
      { type: 'turn_usage', count: 3 },
    ]);
    expect(s.truncated).toEqual([]);
  });

  it('出力は schema を通り、JSON が 16 KiB 以内', () => {
    expect(diagnosticsSummarySchema.safeParse(s).success).toBe(true);
    expect(jsonByteLength(s)).toBeLessThanOrEqual(DIAGNOSTICS_SUMMARY_MAX_BYTES);
  });

  it('topN は 1〜20 の整数（範囲外は例外）', () => {
    expect(() => build(HAND_ROWS, undefined, 0)).toThrow(RangeError);
    expect(() => build(HAND_ROWS, undefined, 21)).toThrow(RangeError);
    expect(build(HAND_ROWS, undefined, 1).perTurn.topManagers.rows).toHaveLength(1);
    expect(build(HAND_ROWS, undefined, 20).perTurn.topManagers.limit).toBe(20);
  });
});

// 漏れの試験: 入力の自由文の欄へ入れた文字列は、出力のどこにも現れない。
// 許可パターン・列挙に合わない値は「落とす」（断らない）。落とした件数だけが droppedValues に残る。
// 許可パターンを通る秘密らしい値だけが「断る」（次の describe）
const LEAK_MARKERS = [
  'altk_',
  'sk-ant',
  'LEAKBODY',
  '依頼文',
  '本文',
  '記憶ファイル',
  '道具名',
  'DROP TABLE',
  'secretmemo',
];

describe('漏れの試験: 自由文の欄は出力に現れない', () => {
  const longBody = `依頼文: これは長い日本語の本文です。LEAKBODY ${'あ'.repeat(200)}`;
  const rows: Row[] = [
    ...HAND_ROWS,
    // managerId に長い文字列・改行・本文
    turnUsage('2026-11-01T03:00:00.000Z', 'm'.repeat(100), model(1, 1)),
    turnUsage('2026-11-01T03:01:00.000Z', 'line1\naltk_LEAKBODY0123456789', model(2, 2)),
    turnUsage('2026-11-01T03:02:00.000Z', longBody, model(3, 3)),
    turnUsage('2026-11-01T03:03:00.000Z', 'mgr-ok\nsecretmemo', model(4, 4)),
    // triggers に不正な形（本文・鍵・オブジェクト）
    turnTiming('2026-11-01T04:00:00.000Z', ['manager_message', longBody], { cacheRead: 1 }),
    turnTiming('2026-11-01T04:01:00.000Z', ['altk_LEAKBODY0123456789'], { cacheRead: 1 }),
    turnTiming('2026-11-01T04:02:00.000Z', [{ body: 'LEAKBODY' }], { cacheRead: 1 }),
    // context_usage の error・カテゴリ名・道具名・MCP サーバ名
    {
      type: 'context_usage',
      id: 'c-err',
      at: '2026-11-01T05:00:00.000Z',
      layer: 'clone',
      site: 'session',
      managerId: 'mgr-a',
      contextUsage: { error: 'sk-ant-api03-LEAKBODY0123456789 依頼文 DROP TABLE' },
    },
    {
      type: 'context_usage',
      id: 'c-leak',
      at: '2026-11-01T05:10:00.000Z',
      layer: 'clone',
      site: 'session',
      managerId: 'mgr-a',
      contextUsage: {
        totalTokens: 10,
        categories: [{ name: '記憶ファイル secretmemo.md', tokens: 5 }],
        messageBreakdown: { toolsByName: [{ name: '道具名_LEAKBODY', tokens: 1 }] },
        mcpToolsByServer: [
          { name: longBody, tokens: 5 },
          { name: 'altk server LEAKBODY', tokens: 5 },
          { name: 'ok-server', tokens: 7 },
        ],
      },
    },
    // 行の型そのものが鍵や本文
    { type: 'altk_LEAKBODY0123456789', at: '2026-11-01T06:00:00.000Z', slowestSql: 'DROP TABLE x' },
    { type: longBody, at: '2026-11-01T06:01:00.000Z' },
    { type: 'http_timing', id: 'h1', at: '2026-11-01T06:02:00.000Z', slowestSql: 'DROP TABLE x' },
  ];
  const usage = {
    rows: [],
    resets: [
      { layer: 'clone', managerId: 'mgr-a', resets: 2, lastResetAt: '2026-11-01T00:00:00.000Z' },
      { layer: 'clone', managerId: longBody, resets: 5, lastResetAt: 'altk_LEAKBODY' },
      { layer: 'altk_LEAKBODY', managerId: 'mgr-b', resets: 1, lastResetAt: null },
    ],
    ledgerDateTimeZone: { state: 'known', name: 'Asia/Tokyo' },
  };
  const s = build(rows, usage);
  const json = JSON.stringify(s);

  it('どの自由文・鍵も出力 JSON に現れない', () => {
    for (const marker of LEAK_MARKERS) expect(json).not.toContain(marker);
  });

  it('落とした値は件数だけが残り、残りの集計は続く', () => {
    expect(s.droppedValues.managerIdRows).toBe(4);
    expect(s.droppedValues.triggerRows).toBe(3);
    expect(s.droppedValues.journalTypeRows).toBe(2);
    expect(s.droppedValues.mcpServerObservations).toBe(2);
    expect(s.droppedValues.resetRows).toBe(2);
    expect(s.perTurn.topManagers.rows.map((m) => m.managerId)).toEqual(['mgr-a', 'mgr-b']);
    expect(s.promptSize.mcpServers.rows.map((m) => m.name)).toContain('ok-server');
    expect(s.resets.ledger).toMatchObject({
      state: 'known',
      total: 8,
      rows: [{ layer: 'clone', managerId: 'mgr-a', resets: 2 }],
    });
    // 型が合わない triggers は「取れない」側へ寄る（起点なしの 0 にはならない）
    expect(s.triggers.rowsWithoutTriggers).toBe(3);
    expect(s.rows.contextUsageErrorRows).toBe(1);
    expect(s.rows.byType.map((e) => e.type)).not.toContain('slowestSql');
  });

  it('出力は schema を通る', () => {
    expect(diagnosticsSummarySchema.safeParse(s).success).toBe(true);
  });
});

describe('秘密らしい値が許可欄に紛れたら生成が例外（fail closed）', () => {
  const secretIds = [
    ['altk_', `altk_${'a1B2'.repeat(10)}`],
    ['altk_ 短い', 'altk_x'],
    ['sk-ant-', 'sk-ant-api03-abcdefghij'],
    ['ghp_', `ghp_${'a1B2c3'.repeat(6)}`],
    ['github_pat_', `github_pat_${'a1B2c3'.repeat(4)}`],
    ['長い hex', 'a'.repeat(8) + '0123456789abcdef'.repeat(2)],
    ['長い base64', 'Zm9vYmFyYmF6cXV4'.repeat(3)],
  ] as const;

  for (const [label, id] of secretIds) {
    it(`managerId: ${label}`, () => {
      const rows = [turnUsage('2026-11-01T00:00:00.000Z', id, model(1, 1))];
      let error: unknown;
      try {
        build(rows);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DiagnosticsSummarySecretError);
      expect((error as Error).message).not.toContain(id);
    });
  }

  it('MCP サーバ名・台帳の managerId に紛れても例外', () => {
    const mcp = {
      type: 'context_usage',
      id: 'c',
      at: '2026-11-01T00:00:00.000Z',
      layer: 'clone',
      site: 'session',
      managerId: 'm',
      contextUsage: {
        totalTokens: 1,
        mcpToolsByServer: [{ name: 'sk-ant-api03-abcdefghij', tokens: 1 }],
      },
    };
    expect(() => build([mcp])).toThrow(DiagnosticsSummarySecretError);
    expect(() =>
      build([], { rows: [], resets: [{ layer: 'clone', managerId: 'altk_zzzz', resets: 1 }] }),
    ).toThrow(DiagnosticsSummarySecretError);
  });

  it('mgr-<uuid> の managerId は通る（誤検出しない）', () => {
    const id = 'mgr-0b9c1e2a-7f3d-4a5b-9c8d-123456789abc';
    const s = build([turnUsage('2026-11-01T00:00:00.000Z', id, model(1, 1))]);
    expect(s.perTurn.topManagers.rows[0]?.managerId).toBe(id);
  });

  it('findSecretPatterns は規則の名前だけを返し、Bearer・PEM も見る', () => {
    expect(findSecretPatterns('{"a":"Bearer abc"}')).toContain('bearer-prefix');
    expect(findSecretPatterns('-----BEGIN PRIVATE KEY-----')).toContain('private-key-pem-header');
    expect(findSecretPatterns('{"a":"mgr-1"}')).toEqual([]);
  });

  it('環境変数の鍵の値が紛れても断る（env を渡したとき）', () => {
    const rows = [turnUsage('2026-11-01T00:00:00.000Z', 'abcdefgh12345678', model(1, 1))];
    expect(() =>
      buildDiagnosticsSummary(
        { journal: journalOf(rows) },
        { now: NOW, env: { ALTEROID_API_TOKEN: 'abcdefgh12345678' } },
      ),
    ).toThrow(DiagnosticsSummarySecretError);
  });
});

describe('diagnosticsSummarySchema は未知の欄を拒否する（.strict()）', () => {
  // 壊した形を作るので、型は緩める
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const valid = build(HAND_ROWS) as unknown as Record<string, any>;
  const clone = () => structuredClone(valid);

  it('先頭・入れ子の未知の欄', () => {
    expect(diagnosticsSummarySchema.safeParse(valid).success).toBe(true);
    const top = clone();
    top.extra = 1;
    expect(diagnosticsSummarySchema.safeParse(top).success).toBe(false);
    const nested = clone();
    nested.cache.fromTurnUsage.overall.extra = 1;
    expect(diagnosticsSummarySchema.safeParse(nested).success).toBe(false);
    const row = clone();
    row.perTurn.topManagers.rows[0].messageBody = 'x';
    expect(diagnosticsSummarySchema.safeParse(row).success).toBe(false);
    const ledger = clone();
    ledger.resets.ledger.note = 'x';
    expect(diagnosticsSummarySchema.safeParse(ledger).success).toBe(false);
  });

  it('許可パターン・列挙に合わない文字列を拒否する', () => {
    const badId = clone();
    badId.perTurn.topManagers.rows[0].managerId = 'a\nb';
    expect(diagnosticsSummarySchema.safeParse(badId).success).toBe(false);
    const longId = clone();
    longId.perTurn.topManagers.rows[0].managerId = 'a'.repeat(81);
    expect(diagnosticsSummarySchema.safeParse(longId).success).toBe(false);
    const badKind = clone();
    badKind.triggers.byKind[0].kind = '依頼文';
    expect(diagnosticsSummarySchema.safeParse(badKind).success).toBe(false);
    const badServer = clone();
    badServer.promptSize.mcpServers.rows[0].name = 'x'.repeat(65);
    expect(diagnosticsSummarySchema.safeParse(badServer).success).toBe(false);
    const badTz = clone();
    badTz.ledgerDateTimeZone = { state: 'known', name: 'これは本文', source: 'usage' };
    expect(diagnosticsSummarySchema.safeParse(badTz).success).toBe(false);
    const badTime = clone();
    badTime.generatedAt = 'yesterday';
    expect(diagnosticsSummarySchema.safeParse(badTime).success).toBe(false);
  });

  it('16 KiB を超える値は schema 側でも拒否する', () => {
    const big = clone();
    big.promptSize.days = Array.from({ length: 31 }, (_, i) => ({
      ...valid.promptSize.days[0],
      day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
    }));
    big.truncated = [];
    // 件数の上限（配列の max）と合計の上限（バイト）の両方が効く: 他の配列も最大まで埋める
    big.resets.ledger = {
      state: 'known',
      baselines: 20,
      total: 20,
      rows: Array.from({ length: 20 }, () => ({
        layer: 'clone',
        managerId: 'm'.repeat(80),
        resets: 1_000_000_000_000,
        lastResetAt: '2026-11-01T00:00:00.000Z',
      })),
    };
    big.perTurn.topManagers.rows = Array.from({ length: 20 }, () => ({
      managerId: 'm'.repeat(80),
      layer: 'clone',
      turns: 1_000_000_000_000,
      cacheRead: 1_000_000_000_000.5,
    }));
    expect(jsonByteLength(big)).toBeGreaterThan(DIAGNOSTICS_SUMMARY_MAX_BYTES);
    expect(diagnosticsSummarySchema.safeParse(big).success).toBe(false);
  });
});

describe('16 KiB を超えるときは畳んで truncated に書く', () => {
  // 31 日ぶんの context_usage（中央値が小数になる値）と、20 以上の委譲・台帳の数え直しで上限を超えさせる
  const rows: Row[] = [];
  for (let d = 1; d <= 31; d += 1) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    for (let k = 0; k < 2; k += 1) {
      rows.push({
        type: 'context_usage',
        id: `c-${d}-${k}`,
        at: `${day}T0${k}:00:00.000Z`,
        layer: 'clone',
        site: 'session',
        managerId: 'm',
        contextUsage: {
          systemPromptTokens: 12_345.5 + d * 1000 + k,
          memoryFileTokens: 22_345.5 + d * 1000 + k * 3,
          mcpToolTokens: 32_345.5 + d * 1000 + k,
          totalTokens: 92_345.5 + d * 1000 + k,
          mcpToolsByServer: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(
            (name, i) => ({
              name: `${name}-server-with-long-name-${'x'.repeat(30)}`,
              tokens: 1000 * (i + 1) + d,
            }),
          ),
        },
      });
    }
  }
  for (let m = 0; m < 25; m += 1) {
    rows.push(
      turnUsage(
        `2026-10-15T00:${String(m).padStart(2, '0')}:00.000Z`,
        `mgr-${String(m).padStart(2, '0')}-${'delegate-'.repeat(6)}end`,
        model(1_000_000_000 + m * 997, 3_000_000 + m, 12345, 6789),
      ),
    );
  }
  const usage = {
    rows: [],
    resets: Array.from({ length: 25 }, (_, m) => ({
      layer: m % 2 === 0 ? 'clone' : 'manager',
      managerId: `mgr-${String(m).padStart(2, '0')}-${'delegate-'.repeat(6)}end`,
      resets: 1000 + m,
      lastResetAt: '2026-11-01T00:00:00.000Z',
    })),
  };

  it('上限を超える入力でも出力は 16 KiB 以内で、畳んだ節が truncated に載る', () => {
    const s = build(rows, usage, 20);
    expect(jsonByteLength(s)).toBeLessThanOrEqual(DIAGNOSTICS_SUMMARY_MAX_BYTES);
    expect(s.truncated.length).toBeGreaterThan(0);
    expect(diagnosticsSummarySchema.safeParse(s).success).toBe(true);
    // 畳む順は価値の低いほう（日別のプロンプト）から
    expect(s.truncated[0]).toBe('promptSizeDays');
    expect(s.promptSize.days.length).toBeLessThan(31);
  });

  it('収まる入力は畳まない', () => {
    expect(build(HAND_ROWS).truncated).toEqual([]);
  });
});

describe('取れない軸は 0 にならない', () => {
  const s = build([
    turnTiming('2026-11-01T00:00:00.000Z', ['timer'], undefined),
    {
      type: 'context_usage',
      id: 'c',
      at: '2026-11-01T00:00:00.000Z',
      layer: 'clone',
      site: 'session',
      managerId: 'm',
      contextUsage: {},
    },
  ]);

  it('合計・比・割合・中央値・台帳は null か理由の列挙値', () => {
    expect(s.cache.fromTurnTiming).toMatchObject({
      rows: 1,
      cacheReadSum: null,
      cacheCreationSum: null,
      readOverCreation: { value: null, missingRows: 1 },
      readRate: { value: null, missingRows: 1 },
    });
    expect(s.cache.fromTurnUsage.overall).toMatchObject({ rows: 0, cacheReadSum: null });
    expect(s.triggers.byKind).toEqual([
      { kind: 'timer', turns: 1, cacheReadSum: null, share: null },
    ]);
    expect(s.triggers.managerMessageIntervals.under60s.share).toBeNull();
    expect(s.promptSize.days[0]?.totalTokens).toEqual({ median: null, max: null, missingRows: 1 });
    expect(s.compactions.turnTimingCompactions).toEqual({ sum: null, missingRows: 1 });
    expect(s.resets.journal).toMatchObject({
      resetCacheRead: null,
      allCacheRead: null,
      cacheReadShare: null,
    });
    expect(s.resets.ledger).toEqual({ state: 'unavailable', reason: 'ledger_not_given' });
    expect(s.ledgerDateTimeZone).toEqual({ state: 'unavailable', reason: 'not_declared' });
    expect(s.ledger).toEqual({ state: 'none' });
  });

  it('空の日誌では期間も null', () => {
    expect(build([]).period).toBeNull();
  });

  it('台帳が申告した時間帯は known で出る。不正な --ledger-tz は unavailable', () => {
    const known = build([], {
      rows: [],
      resets: [],
      ledgerDateTimeZone: { state: 'known', name: 'Asia/Tokyo' },
    });
    expect(known.ledgerDateTimeZone).toEqual({
      state: 'known',
      name: 'Asia/Tokyo',
      source: 'usage',
    });
    const invalid = buildDiagnosticsSummary(
      { journal: journalOf([]) },
      { now: NOW, ledgerTz: 'Mars/Base' },
    );
    expect(invalid.ledgerDateTimeZone).toEqual({ state: 'unavailable', reason: 'invalid' });
  });
});

describe('resets: null（取れない）・[]（0 回）・件数ありは別の出力', () => {
  const none = build([], undefined);
  const nullResets = build([], { rows: [], resets: null });
  const empty = build([], { rows: [], resets: [] });
  const some = build([], {
    rows: [],
    resets: [
      { layer: 'clone', managerId: 'mgr-a', resets: 3, lastResetAt: '2026-11-01T01:02:03.000Z' },
      { layer: 'manager', managerId: 'mgr-b', resets: 1, lastResetAt: null },
    ],
  });

  it('3 通り（と台帳なし）が互いに違う', () => {
    expect(none.resets.ledger).toEqual({ state: 'unavailable', reason: 'ledger_not_given' });
    expect(nullResets.resets.ledger).toEqual({ state: 'unavailable', reason: 'resets_absent' });
    expect(empty.resets.ledger).toEqual({ state: 'known', baselines: 0, total: 0, rows: [] });
    expect(some.resets.ledger).toEqual({
      state: 'known',
      baselines: 2,
      total: 4,
      rows: [
        { layer: 'clone', managerId: 'mgr-a', resets: 3, lastResetAt: '2026-11-01T01:02:03.000Z' },
        { layer: 'manager', managerId: 'mgr-b', resets: 1, lastResetAt: null },
      ],
    });
    const serialized = [nullResets, empty, some].map((x) => JSON.stringify(x.resets.ledger));
    expect(new Set(serialized).size).toBe(3);
  });

  it('日誌の reset 行数と cache read の割合も出る', () => {
    const s = build([
      turnUsage('2026-11-01T00:00:00.000Z', 'mgr-a', model(300, 100)),
      turnUsage('2026-11-01T00:01:00.000Z', 'mgr-a', model(100, 100), { reset: { reason: 'x' } }),
    ]);
    expect(s.resets.journal).toMatchObject({
      turnUsageRows: 2,
      resetRows: 1,
      resetCacheRead: 100,
      allCacheRead: 400,
      cacheReadShare: 0.25,
    });
    expect(s.cache.fromTurnUsage.excludedResetRows).toBe(1);
  });
});
