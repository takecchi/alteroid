import { describe, expect, it } from 'vitest';

import {
  analyzeDiagnostics,
  dateInTimeZone,
  parseJournalJsonl,
  resolveLedgerTimeZone,
  validateIanaTimeZone,
} from './diagnostics-analysis.js';
import { renderDiagnosticsAnalysis } from './diagnostics-analysis-format.js';

const model = (input: number, output: number, cr: number, cc: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cc,
  webSearchRequests: 0,
  costUsd: 0.1,
});

const jsonl = (...rows: unknown[]): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

// 手計算できる合成の日誌（時刻は UTC）。期待値は各 it の中に導出を書く
const timingA = {
  type: 'turn_timing',
  id: 'a',
  at: '2026-11-01T10:00:00.000Z',
  triggers: ['manager_message'],
  batchSize: 2,
  kinds: ['normal'],
  succeeded: true,
  totalMs: 60_000,
  phases: {},
  tokens: { input: 100, cacheRead: 800, cacheCreation: 100, output: 50 },
};
const timingB = {
  ...timingA,
  id: 'b',
  at: '2026-11-01T10:01:30.000Z',
  triggers: ['manager_message', 'timer'],
  batchSize: 1,
  totalMs: 30_000,
  tokens: { input: 0, cacheRead: 200, cacheCreation: 100, output: 10 },
};
// 旧版の行: tokens 欄が無い
const timingLegacy = {
  type: 'turn_timing',
  id: 'c',
  at: '2026-11-02T00:30:00.000Z',
  triggers: ['timer'],
  batchSize: 1,
  kinds: ['normal'],
  succeeded: true,
  totalMs: 10_000,
  phases: {},
};
const usageD = {
  type: 'turn_usage',
  id: 'd',
  at: '2026-11-01T10:00:00.000Z',
  layer: 'clone',
  site: 'session',
  managerId: 'm1',
  sessionId: 's1',
  models: { opus: model(100, 50, 800, 100) },
  compactions: [{ trigger: 'auto', preTokens: 10 }],
};
const usageE = {
  ...usageD,
  id: 'e',
  at: '2026-11-01T10:01:20.000Z',
  models: { opus: model(0, 10, 200, 100) },
  compactions: undefined,
};
// ターンに結べない増分。UTC では 11-01、Asia/Tokyo では 11-02 になる
const usageF = {
  type: 'turn_usage',
  id: 'f',
  at: '2026-11-01T16:00:00.000Z',
  layer: 'manager',
  site: 'session',
  managerId: 'mgrX',
  sessionId: 's2',
  models: { a: model(10, 5, 300, 50), b: model(20, 15, 100, 150) },
};
const usageReset = {
  type: 'turn_usage',
  id: 'g',
  at: '2026-11-01T13:00:00.000Z',
  layer: 'manager',
  site: 'peer',
  managerId: 'mgrY',
  models: { a: model(0, 0, 1000, 0) },
  reset: { fromCostUsd: 5, toCostUsd: 1 },
};
const ctx1 = {
  type: 'context_usage',
  id: 'h1',
  at: '2026-11-01T09:00:00.000Z',
  layer: 'clone',
  site: 'session',
  managerId: 'm1',
  turnSucceeded: true,
  contextUsage: {
    durationMs: 1,
    systemPromptTokens: 100,
    memoryFileTokens: 20,
    mcpToolTokens: 50,
    totalTokens: 1000,
    mcpToolsByServer: [{ name: 'srvA', count: 1, tokens: 40 }],
  },
};
const ctx2 = {
  ...ctx1,
  id: 'h2',
  at: '2026-11-01T09:30:00.000Z',
  contextUsage: { durationMs: 1, systemPromptTokens: 300, mcpToolTokens: 70, totalTokens: 3000 },
};
const ctxError = {
  ...ctx1,
  id: 'h3',
  at: '2026-11-01T09:45:00.000Z',
  contextUsage: { durationMs: 1, error: 'SECRET-BODY sk-ant-xxx' },
};
const http = {
  type: 'http_timing',
  id: 'i',
  at: '2026-11-01T08:00:00.000Z',
  windowMs: 600000,
  requests: 1,
  routes: [],
  slowest: [],
};

const FULL = jsonl(
  timingA,
  timingB,
  timingLegacy,
  usageD,
  usageE,
  usageF,
  usageReset,
  ctx1,
  ctx2,
  ctxError,
  http,
  'not json',
  { a: 1 },
);

const analyze = (text: string, options = {}) =>
  analyzeDiagnostics(parseJournalJsonl(text), options);

describe('parseJournalJsonl', () => {
  it('不正な行は数えて続行し、空行は行数に入れない', () => {
    const parsed = parseJournalJsonl(
      `${JSON.stringify(timingA)}\n\nnot json\n[1]\n{"type":"x"}\n{"type":"x","at":"bad"}\n`,
    );
    expect(parsed.lines).toBe(5);
    expect(parsed.invalidLines).toBe(4);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe('analyzeDiagnostics: 入力の全体像', () => {
  it('期間・行数・型ごとの件数・不正行・旧版の欄無しを出す', () => {
    const a = analyze(FULL);
    expect(a.header.lines).toBe(13);
    expect(a.header.invalidLines).toBe(2);
    expect(a.header.period).toEqual({
      first: '2026-11-01T08:00:00.000Z',
      last: '2026-11-02T00:30:00.000Z',
    });
    expect(a.header.countsByType).toEqual({
      turn_timing: 3,
      turn_usage: 4,
      context_usage: 3,
      http_timing: 1,
    });
    expect(a.header.legacy.turnTimingWithoutTokens).toBe(1);
    expect(a.header.contextUsageErrorRows).toBe(1);
  });

  it('空入力は期間が取れず、どの比も 0 ではなく null', () => {
    const a = analyze('');
    expect(a.header.lines).toBe(0);
    expect(a.header.period).toBeNull();
    expect(a.cache.fromTurnTiming.readOverCreation.value).toBeNull();
    expect(a.cache.fromTurnTiming.sums.cacheRead).toBeNull();
    expect(a.cache.fromTurnUsage.overall.readRate.value).toBeNull();
    expect(a.perTurn.byLayer).toEqual([]);
    expect(a.promptSize.days).toEqual([]);
    expect(a.unlinkedIncrements.unlinkedShare).toBeNull();
    expect(a.triggers.managerMessageIntervals.under60s.share).toBeNull();
  });
});

describe('analyzeDiagnostics: 1. キャッシュ', () => {
  it('turn_timing.tokens: 旧版の行は取れない側に数え、0 を足さない', () => {
    const t = analyze(FULL).cache.fromTurnTiming;
    // A + B の tokens だけ: cacheRead 800+200, creation 100+100, input 100+0
    expect(t.rows).toBe(3);
    expect(t.cacheRead).toEqual({ obtained: 2, missing: 1 });
    expect(t.sums.cacheRead).toBe(1000);
    expect(t.readOverCreation.value).toBe(1000 / 200);
    expect(t.readOverCreation.rows).toEqual({ obtained: 2, missing: 1 });
    expect(t.readRate.value).toBe(1000 / (100 + 1000 + 200));
    // 平均の分母は取れた行（3 で割らない）
    expect(t.perTurn.cacheRead).toBe(500);
  });

  it('turn_usage.models: 増分だけを使い、reset の行は除く。全体・層・場所別', () => {
    const u = analyze(FULL).cache.fromTurnUsage;
    // D + E + F（F は 2 モデルの合計 cr 400 / cc 200 / input 30）
    expect(u.excludedResetRows).toBe(1);
    expect(u.overall.sums.cacheRead).toBe(1400);
    expect(u.overall.sums.cacheCreation).toBe(400);
    expect(u.overall.readOverCreation.value).toBe(3.5);
    expect(u.overall.readRate.value).toBe(1400 / (130 + 1400 + 400));
    expect(u.byLayer.clone?.readOverCreation.value).toBe(1000 / 200);
    expect(u.byLayer.clone?.readRate.value).toBe(1000 / (100 + 1000 + 200));
    expect(u.byLayer.manager?.readOverCreation.value).toBe(2);
    expect(u.bySite.session?.rows).toBe(3);
    expect(u.bySite.peer).toBeUndefined();
    expect(u.byLayerSite['manager/session']?.sums.cacheRead).toBe(400);
  });

  it('比の分母が 0（書き込みが無い）なら null で、無限大にしない', () => {
    const a = analyze(jsonl({ ...usageD, models: { opus: model(0, 0, 100, 0) } }));
    expect(a.cache.fromTurnUsage.overall.readOverCreation.value).toBeNull();
    expect(a.cache.fromTurnUsage.overall.readRate.value).toBe(1);
  });

  it('turn_usage の欄が欠ける行（旧版）は取れない側に数え、取れた行だけで比を出す', () => {
    const broken = { ...usageD, id: 'z', models: { opus: { cacheReadInputTokens: 900 } } };
    const a = analyze(jsonl(usageD, broken));
    const o = a.cache.fromTurnUsage.overall;
    expect(o.readOverCreation.rows).toEqual({ obtained: 1, missing: 1 });
    expect(o.readOverCreation.value).toBe(8);
    expect(o.cacheRead).toEqual({ obtained: 2, missing: 0 });
    expect(a.header.legacy.turnUsageWithoutCacheFields).toBe(1);
  });
});

describe('analyzeDiagnostics: 2. 起点', () => {
  it('束・単一起点ごとのターン数・cache read・平均・割合（tokens の無い行は取れない側）', () => {
    const t = analyze(FULL).triggers;
    // 全体の cache read は A 800 + B 200 = 1000
    const bundle = Object.fromEntries(t.byBundle.map((x) => [x.key, x]));
    expect(bundle.manager_message).toMatchObject({
      turns: 1,
      cacheReadSum: 800,
      cacheReadPerTurn: 800,
      share: 0.8,
    });
    expect(bundle['manager_message+timer']).toMatchObject({
      turns: 1,
      cacheReadSum: 200,
      share: 0.2,
    });
    expect(bundle.timer).toMatchObject({
      turns: 1,
      cacheReadSum: null,
      cacheReadPerTurn: null,
      share: null,
    });
    expect(bundle.timer?.tokenRows).toEqual({ obtained: 0, missing: 1 });
    const single = Object.fromEntries(t.bySingleTrigger.map((x) => [x.key, x]));
    expect(single.manager_message).toMatchObject({ turns: 2, cacheReadSum: 1000, share: 1 });
    expect(single.timer).toMatchObject({
      turns: 2,
      cacheReadSum: 200,
      cacheReadPerTurn: 200,
      share: 0.2,
    });
    expect(single.timer?.tokenRows).toEqual({ obtained: 1, missing: 1 });
  });

  it('batchSize の分布と、manager_message を含むターンの開始間隔', () => {
    const t = analyze(FULL).triggers;
    expect(t.batchSize.distribution).toEqual([
      { batchSize: 1, count: 2 },
      { batchSize: 2, count: 1 },
    ]);
    // 開始 = at − totalMs: A 09:59:00・B 10:01:00 → 間隔 120 秒の 1 件
    expect(t.managerMessageIntervals).toMatchObject({ turns: 2, intervals: 1, withoutBoundary: 0 });
    expect(t.managerMessageIntervals.under60s).toEqual({ count: 0, share: 0 });
    expect(t.managerMessageIntervals.under5min).toEqual({ count: 1, share: 1 });
    expect(t.managerMessageIntervals.under30min).toEqual({ count: 1, share: 1 });
  });

  it('間隔の境界: 60 秒ちょうどは 60 秒未満に入らず、5 分未満に入る', () => {
    const at = (iso: string, totalMs: number, id: string) => ({ ...timingA, id, at: iso, totalMs });
    const a = analyze(
      jsonl(
        at('2026-11-01T10:00:00.000Z', 0, '1'),
        at('2026-11-01T10:01:00.000Z', 0, '2'),
        at('2026-11-01T10:30:00.000Z', 0, '3'),
      ),
    );
    // 間隔は 60 秒・1740 秒
    const iv = a.triggers.managerMessageIntervals;
    expect(iv.intervals).toBe(2);
    expect(iv.under60s.count).toBe(0);
    expect(iv.under5min.count).toBe(1);
    expect(iv.under30min.count).toBe(2);
  });

  it('totalMs の無いターンは開始が取れず、間隔に入れずに数える', () => {
    const noBoundary = { ...timingA, id: 'x', totalMs: undefined };
    const iv = analyze(jsonl(timingA, noBoundary)).triggers.managerMessageIntervals;
    expect(iv.turns).toBe(2);
    expect(iv.withoutBoundary).toBe(1);
    expect(iv.intervals).toBe(0);
  });
});

describe('analyzeDiagnostics: 3. 層・場所・委譲', () => {
  it('ターンあたりの cache read / output と、managerId の cache read 上位（reset は除く）', () => {
    const p = analyze(FULL).perTurn;
    const clone = p.byLayer.find((x) => x.key === 'clone');
    // clone の増分は D・E: cache read (800+200)/2、output (50+10)/2
    expect(clone?.turns).toBe(2);
    expect(clone?.stat.perTurn.cacheRead).toBe(500);
    expect(clone?.stat.perTurn.output).toBe(30);
    expect(p.topManagers.rows.map((r) => [r.managerId, r.cacheRead, r.turns])).toEqual([
      ['m1', 1000, 2],
      ['mgrX', 400, 1],
    ]);
  });

  it('上位 N の件数で切る（全件数は別に持つ）', () => {
    const a = analyze(FULL, { topN: 1 });
    expect(a.perTurn.topManagers.rows).toHaveLength(1);
    expect(a.perTurn.topManagers.totalManagers).toBe(2);
  });
});

describe('analyzeDiagnostics: 4. プロンプトの大きさ', () => {
  it('日（UTC）ごとの中央値・最大。欄の無い行は取れない側。error の行は件数だけ', () => {
    const p = analyze(FULL).promptSize;
    expect(p.days).toHaveLength(1);
    const d = p.days[0];
    expect(d?.day).toBe('2026-11-01');
    expect(d?.rows).toBe(2);
    expect(d?.fields.systemPromptTokens).toEqual({
      median: 200,
      max: 300,
      rows: { obtained: 2, missing: 0 },
    });
    expect(d?.fields.memoryFileTokens).toEqual({
      median: 20,
      max: 20,
      rows: { obtained: 1, missing: 1 },
    });
    expect(d?.fields.mcpToolTokens).toEqual({
      median: 60,
      max: 70,
      rows: { obtained: 2, missing: 0 },
    });
    expect(d?.fields.totalTokens).toEqual({
      median: 2000,
      max: 3000,
      rows: { obtained: 2, missing: 0 },
    });
    expect(p.mcpServers.rows).toEqual([
      { name: 'srvA', observations: 1, medianTokens: 40, maxTokens: 40 },
    ]);
    expect(p.mcpServers.rowsWithoutField).toBe(1);
  });

  it('日付は UTC で切る（UTC 23:59 と翌 00:00 は別の日）', () => {
    const rows = [
      { ...ctx1, id: 'u1', at: '2026-11-01T23:59:59.000Z' },
      { ...ctx1, id: 'u2', at: '2026-11-02T00:00:00.000Z' },
    ];
    expect(analyze(jsonl(...rows)).promptSize.days.map((d) => d.day)).toEqual([
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('大きさの欄が1つも無い context_usage は旧版として数える', () => {
    const legacy = { ...ctx1, contextUsage: { durationMs: 1 } };
    const a = analyze(jsonl(legacy));
    expect(a.header.legacy.contextUsageWithoutSizeFields).toBe(1);
    expect(a.promptSize.days[0]?.fields.totalTokens).toEqual({
      median: null,
      max: null,
      rows: { obtained: 0, missing: 1 },
    });
  });
});

describe('analyzeDiagnostics: 5. compaction と reset', () => {
  it('compaction の件数と sessionId あたり、reset の行数と cache read の割合', () => {
    const c = analyze(FULL).compactionsAndResets;
    expect(c.compactions.turnUsageCompactions).toBe(1);
    expect(c.compactions.turnUsageRowsWithCompactions).toBe(1);
    // s1 は 1 回、s2 は 0 回。sessionId の無い reset 行は別に数える
    expect(c.compactions.perSession).toEqual({
      sessions: 2,
      sessionsWithCompaction: 1,
      max: 1,
      mean: 0.5,
      rowsWithoutSessionId: 1,
    });
    expect(c.compactions.turnTimingCompactions).toEqual({
      sum: null,
      rows: { obtained: 0, missing: 3 },
    });
    // 全 turn_usage の cache read 800+200+400+1000 = 2400、reset 行は 1000
    expect(c.journalReset).toEqual({
      turnUsageRows: 4,
      resetRows: 1,
      resetCacheRead: 1000,
      allCacheRead: 2400,
      cacheReadShare: 1000 / 2400,
    });
  });

  it('turn_timing.compactions は別の行から出した値として別に持つ', () => {
    const withCompaction = { ...timingA, compactions: { count: 3, totalMs: 100 } };
    const c = analyze(jsonl(withCompaction, timingB)).compactionsAndResets.compactions;
    expect(c.turnTimingCompactions).toEqual({ sum: 3, rows: { obtained: 1, missing: 1 } });
    expect(c.turnUsageCompactions).toBe(0);
  });

  it('台帳の resets: 無い・null は取れない、空配列は 0 件で、別の状態になる', () => {
    const base = { rows: [] };
    const reasonOf = (usage: unknown) => analyze('', { usage }).compactionsAndResets.ledgerResets;
    expect(reasonOf(undefined).state).toBe('unavailable');
    expect(reasonOf({ ...base, resets: null }).state).toBe('unavailable');
    expect(reasonOf(base).state).toBe('unavailable');
    expect(reasonOf({ ...base, resets: [] })).toMatchObject({
      state: 'known',
      baselines: 0,
      total: 0,
    });
    const known = reasonOf({
      ...base,
      resets: [
        { layer: 'clone', managerId: 'm1', resets: 2, lastResetAt: '2026-11-01T00:00:00.000Z' },
        { layer: 'manager', managerId: 'm2', resets: 0 },
      ],
    });
    expect(known).toMatchObject({ state: 'known', baselines: 2, total: 2 });
  });

  it('出力: resets が null のときと 0 のときで文面が違う', () => {
    const nullText = renderDiagnosticsAnalysis(analyze('', { usage: { rows: [], resets: null } }));
    const zeroText = renderDiagnosticsAnalysis(analyze('', { usage: { rows: [], resets: [] } }));
    expect(nullText).toContain('台帳の resets: 取れない');
    expect(nullText).not.toContain('合計 0 回');
    expect(zeroText).toContain('台帳の resets: 基準 0 件、合計 0 回');
    expect(zeroText).not.toContain('台帳の resets: 取れない');
  });
});

describe('analyzeDiagnostics: 6. ターンに結べない増分', () => {
  it('どの turn_timing の [at − totalMs, at] にも入らない増分の割合（行数と cache read）', () => {
    const u = analyze(FULL).unlinkedIncrements;
    // 増分は D（窓 A の終端ちょうど）・E（窓 B の中）・F（窓の外）
    expect(u.increments).toBe(3);
    expect(u.unlinked).toBe(1);
    expect(u.unlinkedShare).toBe(1 / 3);
    expect(u.cacheReadUnlinked).toBe(400);
    expect(u.cacheReadAll).toBe(1400);
    expect(u.cacheReadShare).toBe(400 / 1400);
    expect(u.byLayer).toEqual({
      clone: { increments: 2, unlinked: 0 },
      manager: { increments: 1, unlinked: 1 },
    });
  });

  it('境界（totalMs）の無い turn_timing は窓にせず、数える', () => {
    const noBoundary = { ...timingA, totalMs: undefined };
    const u = analyze(jsonl(noBoundary, usageD)).unlinkedIncrements;
    expect(u.turnTimingWithoutBoundary).toBe(1);
    expect(u.turnTimingWindows).toBe(0);
    expect(u.unlinked).toBe(1);
  });
});

describe('時間帯', () => {
  it('validateIanaTimeZone は IANA 名だけを通し、オフセットと未知の名前を断る', () => {
    expect(validateIanaTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(validateIanaTimeZone('UTC')).toBe('UTC');
    expect(validateIanaTimeZone('+09:00')).toBeNull();
    expect(validateIanaTimeZone('Mars/Olympus')).toBeNull();
    expect(validateIanaTimeZone('')).toBeNull();
  });

  it('dateInTimeZone は UTC の瞬間を、その時間帯の暦日へ直す', () => {
    // 2026-11-01T16:00Z は Asia/Tokyo で 11-02 01:00
    expect(dateInTimeZone(Date.parse('2026-11-01T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-02');
    expect(dateInTimeZone(Date.parse('2026-11-01T16:00:00Z'), 'UTC')).toBe('2026-11-01');
    // 米国の夏時間（-07:00）の最後の時間帯: 2026-11-01T06:30Z は 2026-10-31 23:30 PDT
    expect(dateInTimeZone(Date.parse('2026-11-01T06:30:00Z'), 'America/Los_Angeles')).toBe(
      '2026-10-31',
    );
  });

  it('resolveLedgerTimeZone: known が優先、無ければ引数、どちらも無ければ unknown、不正は invalid', () => {
    const known = { ledgerDateTimeZone: { state: 'known', name: 'Asia/Tokyo' } };
    const unavailable = { ledgerDateTimeZone: { state: 'unavailable', note: 'x' } };
    expect(resolveLedgerTimeZone(known, undefined)).toEqual({
      state: 'known',
      name: 'Asia/Tokyo',
      source: 'usage',
    });
    expect(resolveLedgerTimeZone(known, 'UTC')).toMatchObject({
      state: 'known',
      name: 'Asia/Tokyo',
      source: 'usage',
      ignoredArgument: 'UTC',
    });
    expect(resolveLedgerTimeZone(unavailable, 'America/New_York')).toEqual({
      state: 'known',
      name: 'America/New_York',
      source: 'argument',
    });
    expect(resolveLedgerTimeZone(unavailable, undefined)).toEqual({ state: 'unknown' });
    expect(resolveLedgerTimeZone(undefined, undefined)).toEqual({ state: 'unknown' });
    expect(resolveLedgerTimeZone(undefined, 'Nowhere/City').state).toBe('invalid');
    expect(resolveLedgerTimeZone(undefined, '+09:00').state).toBe('invalid');
    expect(
      resolveLedgerTimeZone({ ledgerDateTimeZone: { state: 'known', name: 'Bad/Zone' } }, undefined)
        .state,
    ).toBe('invalid');
  });
});

const ledgerRow = (date: string, layer: string, site: string, cr: number, cc = 0) => ({
  date,
  managerId: 'm1',
  model: 'opus',
  layer,
  site,
  totals: model(1, 1, cr, cc),
  updatedAt: '2026-11-03T00:00:00.000Z',
});

describe('analyzeDiagnostics: 7. 台帳と日誌の日別', () => {
  const usageBase = {
    rows: [
      ledgerRow('2026-10-31', 'clone', 'session', 7),
      ledgerRow('2026-11-01', 'clone', 'session', 1000),
      ledgerRow('2026-11-01', 'manager', 'session', 500),
      ledgerRow('2026-11-02', 'manager', 'session', 400),
    ],
    resets: [],
  };

  it('台帳が known の TZ を申告したらそれを使い、日誌の at をその暦日へ直して並べる', () => {
    const usage = { ...usageBase, ledgerDateTimeZone: { state: 'known', name: 'Asia/Tokyo' } };
    const a = analyze(FULL, { usage });
    expect(a.header.timeZone).toMatchObject({
      state: 'known',
      name: 'Asia/Tokyo',
      source: 'usage',
    });
    expect(a.dailyComparison.state).toBe('joined');
    if (a.dailyComparison.state !== 'joined') return;
    expect(a.dailyComparison.timeZone).toBe('Asia/Tokyo');
    const byDate = Object.fromEntries(a.dailyComparison.rows.map((r) => [r.date, r]));
    // 増分 D・E は JST 11-01（cache read 1000）、F は UTC 16:00 = JST 11-02（400）
    expect(byDate['2026-11-01']?.journal?.cacheRead).toBe(1000);
    expect(byDate['2026-11-01']?.ledger?.cacheReadInputTokens).toBe(1500);
    expect(byDate['2026-11-01']?.ledgerOverJournalCacheRead).toBe(1.5);
    expect(byDate['2026-11-02']?.journal?.cacheRead).toBe(400);
    expect(byDate['2026-11-02']?.ledgerOverJournalCacheRead).toBe(1);
    // 日誌の期間（JST 11-01〜11-02）の外の台帳の日は、日誌は 0 ではなく取れない
    expect(byDate['2026-10-31']?.journal).toBeNull();
    expect(byDate['2026-10-31']?.ledgerOverJournalCacheRead).toBeNull();
    expect(byDate['2026-11-01']?.journalEdgeDay).toBe(true);
  });

  it('同じ日誌を UTC の暦日で並べると、増分 F が別の日に入る（TZ が結果を変える）', () => {
    const a = analyze(FULL, { usage: usageBase, ledgerTz: 'UTC' });
    if (a.dailyComparison.state !== 'joined') throw new Error('joined のはず');
    const byDate = Object.fromEntries(a.dailyComparison.rows.map((r) => [r.date, r]));
    expect(byDate['2026-11-01']?.journal?.cacheRead).toBe(1400);
    // UTC では 11-02 に増分が無いが、期間（〜11-02T00:30Z）の内なので 0 ではなく取れない
    expect(byDate['2026-11-02']?.journal).toMatchObject({ turns: 0, cacheRead: null });
  });

  it('台帳が known を申告していないときだけ --ledger-tz を使う。申告があれば引数は使わず注記する', () => {
    const withArg = analyze(FULL, {
      usage: { ...usageBase, ledgerDateTimeZone: { state: 'unavailable', note: 'n' } },
      ledgerTz: 'Asia/Tokyo',
    });
    expect(withArg.header.timeZone).toMatchObject({
      state: 'known',
      name: 'Asia/Tokyo',
      source: 'argument',
    });
    const both = analyze(FULL, {
      usage: { ...usageBase, ledgerDateTimeZone: { state: 'known', name: 'UTC' } },
      ledgerTz: 'Asia/Tokyo',
    });
    expect(both.header.timeZone).toMatchObject({ name: 'UTC', source: 'usage' });
    expect(both.notices.join('\n')).toContain('--ledger-tz');
  });

  it('TZ がどちらにも無いときは突き合わせず、UTC を既定にしない', () => {
    const a = analyze(FULL, { usage: usageBase });
    expect(a.header.timeZone).toEqual({ state: 'unknown' });
    expect(a.dailyComparison).toMatchObject({ state: 'not_joined' });
    const text = renderDiagnosticsAnalysis(a);
    expect(text).toContain('台帳の TZ が不明なので並べない');
    expect(text).not.toContain('2026-11-01: 台帳');
  });

  it('不正な IANA 名は並べずに理由を出す', () => {
    const a = analyze(FULL, { usage: usageBase, ledgerTz: 'Nowhere/City' });
    expect(a.dailyComparison).toMatchObject({ state: 'not_joined' });
    expect(renderDiagnosticsAnalysis(a)).toContain('Nowhere/City');
  });

  it('台帳が無いときは並べない', () => {
    expect(analyze(FULL).dailyComparison).toMatchObject({ state: 'not_joined' });
  });
});

describe('analyzeDiagnostics: 台帳の二重計上の期間（#5402 より前）', () => {
  it('台帳の日付が 2026-10-26〜27 にかかるなら注記し、その期間の clone/session の cache_read 合計を添える', () => {
    const usage = {
      rows: [
        ledgerRow('2026-10-26', 'clone', 'session', 5000),
        ledgerRow('2026-10-27', 'clone', 'session', 100),
        ledgerRow('2026-10-27', 'manager', 'session', 9),
      ],
    };
    const a = analyze('', { usage });
    expect(a.notices).toHaveLength(1);
    expect(a.notices[0]).toContain('#5402');
    expect(a.notices[0]).toContain('5,100');
    expect(renderDiagnosticsAnalysis(a)).toContain('⚠');
  });

  it('かからないなら注記しない（端の日 10-25 と 10-28 も含めない）', () => {
    const usage = {
      rows: [
        ledgerRow('2026-10-25', 'clone', 'session', 1),
        ledgerRow('2026-10-28', 'clone', 'session', 1),
      ],
    };
    expect(analyze('', { usage }).notices).toEqual([]);
  });
});

describe('出力に本文・鍵を出さない', () => {
  it('context_usage.error の文字列は JSON にも表にも出ない', () => {
    const a = analyze(FULL);
    expect(JSON.stringify(a)).not.toContain('SECRET-BODY');
    expect(renderDiagnosticsAnalysis(a)).not.toContain('SECRET-BODY');
    expect(JSON.stringify(a)).not.toContain('sk-ant');
  });

  it('集計キーの制御文字を除き、長い名前を切る', () => {
    const evil = { ...usageD, managerId: `m\u0007${'x'.repeat(200)}` };
    const key = analyze(jsonl(evil)).perTurn.topManagers.rows[0]?.managerId ?? '';
    expect(key).not.toContain('\u0007');
    expect(key.length).toBeLessThan(80);
  });
});

describe('renderDiagnosticsAnalysis', () => {
  it('先頭に TZ・期間・行数・型ごとの件数・旧版の行数・不正行を出し、断定の語を使わない', () => {
    const text = renderDiagnosticsAnalysis(
      analyze(FULL, { ledgerTz: 'Asia/Tokyo', usage: { rows: [] } }),
    );
    const head = text.split('\n').slice(0, 8).join('\n');
    expect(head).toContain('Asia/Tokyo');
    expect(head).toContain('2026-11-01T08:00:00.000Z 〜 2026-11-02T00:30:00.000Z');
    expect(head).toContain('日誌の行数: 13（読めない行 2）');
    expect(head).toContain('turn_timing 3');
    expect(head).toContain('tokens 無し 1');
    // 1 行目の見出し（「原因は断定しない」と断る文）を除いた本文に、断定の語が無い
    expect(text.split('\n').slice(1).join('\n')).not.toMatch(
      /原因は|が原因|間違いなく|ことが分かる|効いていない|膨らんでいる/,
    );
  });

  it('取れない軸は 0 ではなく「取れない」と書く', () => {
    const text = renderDiagnosticsAnalysis(analyze(jsonl(timingLegacy)));
    expect(text).toContain('read÷creation 取れない');
    expect(text).toContain('cache read 合計 取れない');
  });
});
