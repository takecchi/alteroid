// 診断の日誌（`alteroid diagnostics export` の JSONL）と台帳（`alteroid usage --json`）を読んで、トークンの使い方の事実を並べる純関数。
// 読み取りのみ・通信なし・zod を import しない: 行は構造として疑って読み（欄が無い・型が違う行は「取れない」に数える）、後続の要約・定期送信が同じ集計を再利用するため。
// ブラウザバンドルへ入れない: `index.ts`（バレル）からだけ出し、`apps/web` は値で import できない（eslint）。
// 入力の自由文（`error`・カテゴリ名・道具名）は集計に使わない。名前は MCP サーバ名・managerId・起点の種類の集計キーとしてだけ出す。
import { USAGE_LAYERS, USAGE_SITES } from './usage-format.js';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// #5402 より前の期間（台帳の date の暦日。サーバのローカル）。この期間の clone/session の cache_read は約 108 億多い（二重計上）
export const LEDGER_DOUBLE_COUNT_PERIOD = { from: '2026-10-26', to: '2026-10-27' } as const;
export const LEDGER_DOUBLE_COUNT_APPROX_CACHE_READ = 10_800_000_000;

/** 取れた件数と取れなかった件数。取れない軸を 0 にしない */
export interface Coverage {
  obtained: number;
  missing: number;
}

export interface TokenStat {
  /** 集計に入った行数（取れた・取れないを問わない） */
  rows: number;
  cacheRead: Coverage;
  cacheCreation: Coverage;
  input: Coverage;
  output: Coverage;
  /** 合計は取れた行だけの足し算。1行も取れなければ null（0 にしない） */
  sums: {
    cacheRead: number | null;
    cacheCreation: number | null;
    input: number | null;
    output: number | null;
  };
  /** cache read ÷ cache creation。read と creation の両方が取れた行だけで計算。書き込みが 0 なら null */
  readOverCreation: { value: number | null; rows: Coverage };
  /** cache read ÷（input + cache read + cache creation）。3つとも取れた行だけで計算 */
  readRate: { value: number | null; rows: Coverage };
  perTurn: { cacheRead: number | null; output: number | null };
}

interface Tokens {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
}

class TokenAcc {
  rows = 0;
  readonly f = {
    input: { s: 0, n: 0 },
    cacheRead: { s: 0, n: 0 },
    cacheCreation: { s: 0, n: 0 },
    output: { s: 0, n: 0 },
  };
  readonly pair = { cr: 0, cc: 0, n: 0 };
  readonly triple = { i: 0, cr: 0, cc: 0, n: 0 };

  add(t: Tokens): void {
    this.rows += 1;
    for (const key of ['input', 'cacheRead', 'cacheCreation', 'output'] as const) {
      const v = t[key];
      if (v !== undefined) {
        this.f[key].s += v;
        this.f[key].n += 1;
      }
    }
    if (t.cacheRead !== undefined && t.cacheCreation !== undefined) {
      this.pair.cr += t.cacheRead;
      this.pair.cc += t.cacheCreation;
      this.pair.n += 1;
      if (t.input !== undefined) {
        this.triple.i += t.input;
        this.triple.cr += t.cacheRead;
        this.triple.cc += t.cacheCreation;
        this.triple.n += 1;
      }
    }
  }

  stat(): TokenStat {
    const cov = (key: keyof typeof this.f): Coverage => ({
      obtained: this.f[key].n,
      missing: this.rows - this.f[key].n,
    });
    const sum = (key: keyof typeof this.f): number | null =>
      this.f[key].n === 0 ? null : this.f[key].s;
    const tripleDen = this.triple.i + this.triple.cr + this.triple.cc;
    return {
      rows: this.rows,
      cacheRead: cov('cacheRead'),
      cacheCreation: cov('cacheCreation'),
      input: cov('input'),
      output: cov('output'),
      sums: {
        cacheRead: sum('cacheRead'),
        cacheCreation: sum('cacheCreation'),
        input: sum('input'),
        output: sum('output'),
      },
      readOverCreation: {
        value: this.pair.n === 0 || this.pair.cc === 0 ? null : this.pair.cr / this.pair.cc,
        rows: { obtained: this.pair.n, missing: this.rows - this.pair.n },
      },
      readRate: {
        value: this.triple.n === 0 || tripleDen === 0 ? null : this.triple.cr / tripleDen,
        rows: { obtained: this.triple.n, missing: this.rows - this.triple.n },
      },
      perTurn: {
        cacheRead: this.f.cacheRead.n === 0 ? null : this.f.cacheRead.s / this.f.cacheRead.n,
        output: this.f.output.n === 0 ? null : this.f.output.s / this.f.output.n,
      },
    };
  }
}

// ---- 入力を読む ----

interface Row {
  type: string;
  at: string;
  atMs: number;
  raw: Obj;
}

export interface ParsedJournal {
  rows: Row[];
  /** 空行を除いた行数 */
  lines: number;
  /** JSON でない・オブジェクトでない・type / at が読めない行。数えて続行する */
  invalidLines: number;
}

export function parseJournalJsonl(text: string): ParsedJournal {
  const rows: Row[] = [];
  let lines = 0;
  let invalidLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (!isObj(value) || typeof value.type !== 'string' || typeof value.at !== 'string') {
      invalidLines += 1;
      continue;
    }
    const atMs = Date.parse(value.at);
    if (Number.isNaN(atMs)) {
      invalidLines += 1;
      continue;
    }
    rows.push({ type: value.type, at: value.at, atMs, raw: value });
  }
  return { rows, lines, invalidLines };
}

// 集計キーとして出す名前から制御文字を除き、長さを切る: 入力の自由文が出力へ紛れないように
function safeKey(value: unknown, fallback = '(取れない)'): string {
  if (typeof value !== 'string' || value === '') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
}

const LAYERS: readonly string[] = USAGE_LAYERS;
const SITES: readonly string[] = USAGE_SITES;
const closedKey = (value: unknown, set: readonly string[]): string =>
  typeof value === 'string' && set.includes(value) ? value : '(取れない)';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---- 時間帯 ----

/** IANA 名だけを通す。UTC オフセット（`+09:00`）や未知の名前は null */
export function validateIanaTimeZone(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
export function dateInTimeZone(ms: number, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(ms));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '??';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export type TimeZoneResolution =
  | { state: 'known'; name: string; source: 'usage' | 'argument'; ignoredArgument?: string }
  | { state: 'unknown' }
  | { state: 'invalid'; given: string; source: 'usage' | 'argument'; reason: string };

/**
 * 台帳の date の時間帯を決める。`ledgerDateTimeZone` が `{state:'known', name}` ならそれを優先し、そうでないときだけ引数を使う。
 * どちらも無ければ unknown（UTC を既定にしない・推測しない）
 */
export function resolveLedgerTimeZone(
  usage: unknown,
  argument: string | undefined,
): TimeZoneResolution {
  const declared =
    isObj(usage) && isObj(usage.ledgerDateTimeZone) ? usage.ledgerDateTimeZone : null;
  if (declared !== null && declared.state === 'known' && typeof declared.name === 'string') {
    const name = validateIanaTimeZone(declared.name);
    if (name === null) {
      return {
        state: 'invalid',
        given: safeKey(declared.name),
        source: 'usage',
        reason: '台帳が申告した時間帯名が IANA の名前として読めない',
      };
    }
    const ignored = argument !== undefined && validateIanaTimeZone(argument) !== name;
    return {
      state: 'known',
      name,
      source: 'usage',
      ...(ignored && argument !== undefined ? { ignoredArgument: safeKey(argument) } : {}),
    };
  }
  if (argument === undefined) return { state: 'unknown' };
  const name = validateIanaTimeZone(argument);
  if (name === null) {
    return {
      state: 'invalid',
      given: safeKey(argument),
      source: 'argument',
      reason: 'IANA の時間帯名（例: Asia/Tokyo）として読めない。UTC オフセットの書き方も受けない',
    };
  }
  return { state: 'known', name, source: 'argument' };
}

// ---- 結果の型 ----

export interface TriggerStat {
  key: string;
  turns: number;
  /** cache read が取れたターン数（tokens が無い旧版の行は取れない側） */
  tokenRows: Coverage;
  cacheReadSum: number | null;
  cacheReadPerTurn: number | null;
  /** 全 turn_timing の cache read 合計に占める割合。合計が取れなければ null */
  share: number | null;
}

export interface IntervalStat {
  /** manager_message を起点に含むターン数（報告・質問・許可の別は turn_timing に無く、区別できない） */
  turns: number;
  /** 開始（at − totalMs）が取れないターン */
  withoutBoundary: number;
  intervals: number;
  under60s: { count: number; share: number | null };
  under5min: { count: number; share: number | null };
  under30min: { count: number; share: number | null };
}

export interface ContextSizeDay {
  day: string;
  rows: number;
  fields: Record<
    'systemPromptTokens' | 'memoryFileTokens' | 'mcpToolTokens' | 'totalTokens',
    { median: number | null; max: number | null; rows: Coverage }
  >;
}

export interface LedgerDay {
  date: string;
  rows: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
}

export interface DailyComparisonRow {
  date: string;
  ledger: LedgerDay | null;
  journal: {
    turns: number;
    cacheRead: number | null;
    cacheCreation: number | null;
    input: number | null;
    output: number | null;
  } | null;
  /** 台帳の cache read ÷ 日誌の cache read。どちらかが取れない・日誌が 0 なら null */
  ledgerOverJournalCacheRead: number | null;
  /** 日誌の期間の端の日（一部の時間しか入っていない） */
  journalEdgeDay: boolean;
}

export interface ResetLedgerRow {
  layer: string;
  managerId: string;
  resets: number;
  lastResetAt: string | null;
}

export interface DiagnosticsAnalysis {
  header: {
    period: { first: string; last: string } | null;
    lines: number;
    invalidLines: number;
    countsByType: Record<string, number>;
    legacy: {
      /** turn_timing のうち tokens が無い行（旧版） */
      turnTimingWithoutTokens: number;
      /** context_usage のうち、大きさの欄（4つ）が1つも無く error でもない行 */
      contextUsageWithoutSizeFields: number;
      /** turn_usage のうち models から cache read / creation が取れない行 */
      turnUsageWithoutCacheFields: number;
    };
    contextUsageErrorRows: number;
    timeZone: TimeZoneResolution;
    ledger:
      | { state: 'none' }
      | { state: 'unreadable'; reason: string }
      | {
          state: 'read';
          rows: number;
          skippedRows: number;
          dates: { first: string; last: string } | null;
        };
  };
  cache: {
    /** turn_timing.tokens: ターン単位（メインループの消費）。層・場所は行に無いので全体だけ */
    fromTurnTiming: TokenStat;
    /** turn_usage.models: 増分。reset を持つ行は増分ではないので除く */
    fromTurnUsage: {
      overall: TokenStat;
      byLayer: Record<string, TokenStat>;
      bySite: Record<string, TokenStat>;
      byLayerSite: Record<string, TokenStat>;
      excludedResetRows: number;
    };
  };
  triggers: {
    /** 起点の組（束）ごと。distinct な triggers を並べ替えて `+` で繋いだ名前 */
    byBundle: TriggerStat[];
    /** 1つの起点ごと。束は構成する起点すべてに数えるので、割合の合計は 100% を超えうる */
    bySingleTrigger: TriggerStat[];
    triggersMissingRows: number;
    batchSize: { distribution: Array<{ batchSize: number; count: number }>; rows: Coverage };
    managerMessageIntervals: IntervalStat;
  };
  perTurn: {
    byLayer: Array<{ key: string; turns: number; stat: TokenStat }>;
    bySite: Array<{ key: string; turns: number; stat: TokenStat }>;
    topManagers: {
      limit: number;
      totalManagers: number;
      rows: Array<{
        managerId: string;
        layer: string;
        turns: number;
        cacheRead: number | null;
        cacheReadRows: Coverage;
      }>;
    };
  };
  promptSize: {
    days: ContextSizeDay[];
    mcpServers: {
      limit: number;
      totalServers: number;
      rows: Array<{ name: string; observations: number; medianTokens: number; maxTokens: number }>;
      rowsWithoutField: number;
    };
  };
  compactionsAndResets: {
    compactions: {
      turnUsageRowsWithCompactions: number;
      turnUsageCompactions: number;
      /** turn_timing.compactions.count の合計（別の行から出した値） */
      turnTimingCompactions: { sum: number | null; rows: Coverage };
      perSession: {
        sessions: number;
        sessionsWithCompaction: number;
        max: number | null;
        mean: number | null;
        rowsWithoutSessionId: number;
      };
    };
    journalReset: {
      turnUsageRows: number;
      resetRows: number;
      resetCacheRead: number | null;
      allCacheRead: number | null;
      /** reset 行の cache read ÷ 全 turn_usage の cache read */
      cacheReadShare: number | null;
    };
    ledgerResets:
      | { state: 'unavailable'; reason: string }
      | { state: 'known'; baselines: number; total: number; rows: ResetLedgerRow[] };
  };
  unlinkedIncrements: {
    /** 増分（reset でない turn_usage）のうち、どの turn_timing の [at − totalMs, at] にも入らないもの */
    increments: number;
    unlinked: number;
    unlinkedShare: number | null;
    cacheReadUnlinked: number | null;
    cacheReadAll: number | null;
    cacheReadShare: number | null;
    turnTimingWindows: number;
    turnTimingWithoutBoundary: number;
    byLayer: Record<string, { increments: number; unlinked: number }>;
  };
  dailyComparison:
    | { state: 'not_joined'; reason: string }
    | { state: 'joined'; timeZone: string; rows: DailyComparisonRow[] };
  notices: string[];
}

export interface AnalyzeOptions {
  /** `--usage` の中身（JSON を parse したもの）。無ければ台帳なし */
  usage?: unknown;
  /** `--ledger-tz`。台帳が `known` を申告していないときだけ使う */
  ledgerTz?: string;
  topN?: number;
}

// ---- 本体 ----

function tokensOfTurnUsage(raw: Obj): Tokens {
  const models = isObj(raw.models) ? Object.values(raw.models) : [];
  if (models.length === 0) return {};
  const sumOf = (key: string): number | undefined => {
    let total = 0;
    for (const model of models) {
      const v = isObj(model) ? num(model[key]) : undefined;
      if (v === undefined) return undefined;
      total += v;
    }
    return total;
  };
  const out: Tokens = {};
  const input = sumOf('inputTokens');
  const cacheRead = sumOf('cacheReadInputTokens');
  const cacheCreation = sumOf('cacheCreationInputTokens');
  const output = sumOf('outputTokens');
  if (input !== undefined) out.input = input;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheCreation !== undefined) out.cacheCreation = cacheCreation;
  if (output !== undefined) out.output = output;
  return out;
}

function tokensOfTurnTiming(raw: Obj): Tokens | null {
  if (!isObj(raw.tokens)) return null;
  const t = raw.tokens;
  const out: Tokens = {};
  const input = num(t.input);
  const cacheRead = num(t.cacheRead);
  const cacheCreation = num(t.cacheCreation);
  const output = num(t.output);
  if (input !== undefined) out.input = input;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheCreation !== undefined) out.cacheCreation = cacheCreation;
  if (output !== undefined) out.output = output;
  return out;
}

function groupStat<K extends string>(map: Map<K, TokenAcc>): Record<string, TokenStat> {
  const out: Record<string, TokenStat> = {};
  for (const key of [...map.keys()].sort()) out[key] = (map.get(key) as TokenAcc).stat();
  return out;
}

function accFor<K>(map: Map<K, TokenAcc>, key: K): TokenAcc {
  let acc = map.get(key);
  if (acc === undefined) {
    acc = new TokenAcc();
    map.set(key, acc);
  }
  return acc;
}

function share(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

const SIZE_FIELDS = [
  'systemPromptTokens',
  'memoryFileTokens',
  'mcpToolTokens',
  'totalTokens',
] as const;

interface LedgerParse {
  header: DiagnosticsAnalysis['header']['ledger'];
  days: Map<string, LedgerDay>;
  rawRows: Array<{ date: string; layer: unknown; site: unknown; cacheRead: number | undefined }>;
  resets: DiagnosticsAnalysis['compactionsAndResets']['ledgerResets'];
}

function parseLedger(usage: unknown): LedgerParse {
  const none: LedgerParse = {
    header: { state: 'none' },
    days: new Map(),
    rawRows: [],
    resets: {
      state: 'unavailable',
      reason: '台帳（--usage）が渡されていない。0 回ではなく取れていない',
    },
  };
  if (usage === undefined) return none;
  if (!isObj(usage) || !Array.isArray(usage.rows)) {
    return {
      ...none,
      header: { state: 'unreadable', reason: '台帳として読めない（rows の配列が無い）' },
      resets: {
        state: 'unavailable',
        reason: '台帳が読めないので取れていない。0 回ではない',
      },
    };
  }
  const acc = new Map<string, { rows: number; f: Record<string, { s: number; n: number }> }>();
  const rawRows: LedgerParse['rawRows'] = [];
  let skipped = 0;
  const dates: string[] = [];
  for (const row of usage.rows) {
    if (!isObj(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      skipped += 1;
      continue;
    }
    const totals = isObj(row.totals) ? row.totals : {};
    const entry = acc.get(row.date) ?? {
      rows: 0,
      f: {
        inputTokens: { s: 0, n: 0 },
        outputTokens: { s: 0, n: 0 },
        cacheReadInputTokens: { s: 0, n: 0 },
        cacheCreationInputTokens: { s: 0, n: 0 },
        costUsd: { s: 0, n: 0 },
      },
    };
    entry.rows += 1;
    for (const [key, slot] of Object.entries(entry.f)) {
      const v = num(totals[key]);
      if (v !== undefined) {
        slot.s += v;
        slot.n += 1;
      }
    }
    acc.set(row.date, entry);
    dates.push(row.date);
    rawRows.push({
      date: row.date,
      layer: row.layer,
      site: row.site,
      cacheRead: num(totals.cacheReadInputTokens),
    });
  }
  const days = new Map<string, LedgerDay>();
  for (const [date, entry] of acc) {
    const v = (key: string): number | null => {
      const slot = entry.f[key];
      return slot === undefined || slot.n === 0 ? null : slot.s;
    };
    days.set(date, {
      date,
      rows: entry.rows,
      inputTokens: v('inputTokens'),
      outputTokens: v('outputTokens'),
      cacheReadInputTokens: v('cacheReadInputTokens'),
      cacheCreationInputTokens: v('cacheCreationInputTokens'),
      costUsd: v('costUsd'),
    });
  }
  dates.sort();
  let resets: LedgerParse['resets'];
  if (!Array.isArray(usage.resets)) {
    resets = {
      state: 'unavailable',
      reason: 'この台帳の応答に resets が無い（古いデーモン・null）。0 回ではなく取れていない',
    };
  } else {
    const rows: ResetLedgerRow[] = [];
    for (const r of usage.resets) {
      const count = isObj(r) ? num(r.resets) : undefined;
      if (!isObj(r) || count === undefined) continue;
      rows.push({
        layer: closedKey(r.layer, LAYERS),
        managerId: safeKey(r.managerId),
        resets: count,
        lastResetAt: typeof r.lastResetAt === 'string' ? r.lastResetAt : null,
      });
    }
    resets = {
      state: 'known',
      baselines: rows.length,
      total: rows.reduce((s, r) => s + r.resets, 0),
      rows,
    };
  }
  return {
    header: {
      state: 'read',
      rows: rawRows.length,
      skippedRows: skipped,
      dates:
        dates.length === 0
          ? null
          : { first: dates[0] as string, last: dates[dates.length - 1] as string },
    },
    days,
    rawRows,
    resets,
  };
}

export function analyzeDiagnostics(
  journal: ParsedJournal,
  options: AnalyzeOptions = {},
): DiagnosticsAnalysis {
  const topN = options.topN ?? 10;
  const timeZone = resolveLedgerTimeZone(options.usage, options.ledgerTz);
  const ledger = parseLedger(options.usage);

  const countsByType: Record<string, number> = {};
  const timing: Row[] = [];
  const usageRows: Row[] = [];
  const contextRows: Row[] = [];
  let first = Infinity;
  let last = -Infinity;
  for (const row of journal.rows) {
    const key = safeKey(row.type);
    countsByType[key] = (countsByType[key] ?? 0) + 1;
    first = Math.min(first, row.atMs);
    last = Math.max(last, row.atMs);
    if (row.type === 'turn_timing') timing.push(row);
    else if (row.type === 'turn_usage') usageRows.push(row);
    else if (row.type === 'context_usage') contextRows.push(row);
  }

  // ---- 1. キャッシュ ----
  const timingAcc = new TokenAcc();
  let timingWithoutTokens = 0;
  for (const row of timing) {
    const tokens = tokensOfTurnTiming(row.raw);
    if (tokens === null) {
      timingWithoutTokens += 1;
      // tokens 欄の無い行は「取れない」: 行数には数えるが、どの軸も取れた側に入れない
      timingAcc.add({});
    } else timingAcc.add(tokens);
  }

  const overall = new TokenAcc();
  const byLayer = new Map<string, TokenAcc>();
  const bySite = new Map<string, TokenAcc>();
  const byLayerSite = new Map<string, TokenAcc>();
  const byManager = new Map<string, { layer: string; acc: TokenAcc }>();
  let excludedResetRows = 0;
  let usageWithoutCache = 0;
  let resetCacheRead = 0;
  let resetCacheReadRows = 0;
  let allCacheRead = 0;
  let allCacheReadRows = 0;
  let resetRows = 0;
  const increments: Array<{ row: Row; layer: string; cacheRead: number | undefined }> = [];
  const compactionBySession = new Map<string, number>();
  let rowsWithoutSessionId = 0;
  let compactionRows = 0;
  let compactionCount = 0;
  for (const row of usageRows) {
    const tokens = tokensOfTurnUsage(row.raw);
    if (tokens.cacheRead === undefined || tokens.cacheCreation === undefined)
      usageWithoutCache += 1;
    const layer = closedKey(row.raw.layer, LAYERS);
    const site = closedKey(row.raw.site, SITES);
    if (tokens.cacheRead !== undefined) {
      allCacheRead += tokens.cacheRead;
      allCacheReadRows += 1;
    }
    const isReset = row.raw.reset !== undefined && row.raw.reset !== null;
    const compactions = Array.isArray(row.raw.compactions) ? row.raw.compactions.length : 0;
    if (compactions > 0) {
      compactionRows += 1;
      compactionCount += compactions;
    }
    if (typeof row.raw.sessionId === 'string') {
      const sid = row.raw.sessionId;
      compactionBySession.set(sid, (compactionBySession.get(sid) ?? 0) + compactions);
    } else rowsWithoutSessionId += 1;
    if (isReset) {
      resetRows += 1;
      excludedResetRows += 1;
      if (tokens.cacheRead !== undefined) {
        resetCacheRead += tokens.cacheRead;
        resetCacheReadRows += 1;
      }
      continue;
    }
    overall.add(tokens);
    accFor(byLayer, layer).add(tokens);
    accFor(bySite, site).add(tokens);
    accFor(byLayerSite, `${layer}/${site}`).add(tokens);
    const manager = safeKey(row.raw.managerId);
    const mgr = byManager.get(manager) ?? { layer, acc: new TokenAcc() };
    mgr.acc.add(tokens);
    byManager.set(manager, mgr);
    increments.push({ row, layer, cacheRead: tokens.cacheRead });
  }

  // ---- 2. 起点 ----
  const bundleAcc = new Map<string, { turns: number; acc: TokenAcc }>();
  const singleAcc = new Map<string, { turns: number; acc: TokenAcc }>();
  let triggersMissing = 0;
  const batch = new Map<number, number>();
  let batchMissing = 0;
  const mmStarts: number[] = [];
  let mmTurns = 0;
  let mmWithoutBoundary = 0;
  let timingCompactionSum = 0;
  let timingCompactionRows = 0;
  const windows: Array<{ start: number; end: number }> = [];
  let timingWithoutBoundary = 0;
  let timingCacheReadTotal = 0;
  let timingCacheReadRows = 0;
  for (const row of timing) {
    const tokens = tokensOfTurnTiming(row.raw);
    if (tokens?.cacheRead !== undefined) {
      timingCacheReadTotal += tokens.cacheRead;
      timingCacheReadRows += 1;
    }
    const bs = num(row.raw.batchSize);
    if (bs === undefined) batchMissing += 1;
    else batch.set(bs, (batch.get(bs) ?? 0) + 1);
    const totalMs = num(row.raw.totalMs);
    if (totalMs === undefined) timingWithoutBoundary += 1;
    else windows.push({ start: row.atMs - totalMs, end: row.atMs });
    if (isObj(row.raw.compactions)) {
      const c = num(row.raw.compactions.count);
      if (c !== undefined) {
        timingCompactionSum += c;
        timingCompactionRows += 1;
      }
    }
    if (!Array.isArray(row.raw.triggers) || !row.raw.triggers.every((t) => typeof t === 'string')) {
      triggersMissing += 1;
      continue;
    }
    const distinct = [...new Set(row.raw.triggers as string[])].map((t) => safeKey(t)).sort();
    const bundleKey = distinct.length === 0 ? '(起点なし)' : distinct.join('+');
    const tokenFor = tokens ?? {};
    const b = bundleAcc.get(bundleKey) ?? { turns: 0, acc: new TokenAcc() };
    b.turns += 1;
    b.acc.add(tokenFor);
    bundleAcc.set(bundleKey, b);
    for (const key of distinct.length === 0 ? ['(起点なし)'] : distinct) {
      const s = singleAcc.get(key) ?? { turns: 0, acc: new TokenAcc() };
      s.turns += 1;
      s.acc.add(tokenFor);
      singleAcc.set(key, s);
    }
    if ((row.raw.triggers as string[]).includes('manager_message')) {
      mmTurns += 1;
      if (totalMs === undefined) mmWithoutBoundary += 1;
      else mmStarts.push(row.atMs - totalMs);
    }
  }
  const triggerStats = (map: Map<string, { turns: number; acc: TokenAcc }>): TriggerStat[] =>
    [...map.entries()]
      .map(([key, { turns, acc }]): TriggerStat => {
        const stat = acc.stat();
        return {
          key,
          turns,
          tokenRows: stat.cacheRead,
          cacheReadSum: stat.sums.cacheRead,
          cacheReadPerTurn: stat.perTurn.cacheRead,
          share:
            stat.sums.cacheRead === null || timingCacheReadRows === 0
              ? null
              : share(stat.sums.cacheRead, timingCacheReadTotal),
        };
      })
      .sort(
        (a, b) => (b.cacheReadSum ?? -1) - (a.cacheReadSum ?? -1) || a.key.localeCompare(b.key),
      );
  mmStarts.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < mmStarts.length; i += 1)
    gaps.push((mmStarts[i] as number) - (mmStarts[i - 1] as number));
  const under = (ms: number): { count: number; share: number | null } => {
    const count = gaps.filter((g) => g < ms).length;
    return { count, share: share(count, gaps.length) };
  };

  // ---- 3. 層・場所・委譲 ----
  const layerSiteList = (
    map: Map<string, TokenAcc>,
  ): Array<{ key: string; turns: number; stat: TokenStat }> =>
    [...map.keys()].sort().map((key) => {
      const acc = map.get(key) as TokenAcc;
      return { key, turns: acc.rows, stat: acc.stat() };
    });
  const managers = [...byManager.entries()]
    .map(([managerId, { layer, acc }]) => {
      const stat = acc.stat();
      return {
        managerId,
        layer,
        turns: acc.rows,
        cacheRead: stat.sums.cacheRead,
        cacheReadRows: stat.cacheRead,
      };
    })
    .sort(
      (a, b) => (b.cacheRead ?? -1) - (a.cacheRead ?? -1) || a.managerId.localeCompare(b.managerId),
    );

  // ---- 4. プロンプトの大きさ ----
  const dayMap = new Map<string, Row[]>();
  let contextErrorRows = 0;
  let contextWithoutSize = 0;
  const serverObs = new Map<string, number[]>();
  let serversWithoutField = 0;
  for (const row of contextRows) {
    const cu = isObj(row.raw.contextUsage) ? row.raw.contextUsage : null;
    if (cu !== null && cu.error !== undefined) {
      // 文字列は出さず件数だけ
      contextErrorRows += 1;
      continue;
    }
    const list = dayMap.get(utcDay(row.atMs)) ?? [];
    list.push(row);
    dayMap.set(utcDay(row.atMs), list);
    if (cu === null || SIZE_FIELDS.every((f) => num(cu[f]) === undefined)) contextWithoutSize += 1;
    if (cu === null || !Array.isArray(cu.mcpToolsByServer)) serversWithoutField += 1;
    else {
      for (const s of cu.mcpToolsByServer) {
        const tokens = isObj(s) ? num(s.tokens) : undefined;
        if (!isObj(s) || tokens === undefined) continue;
        const name = safeKey(s.name);
        const list2 = serverObs.get(name) ?? [];
        list2.push(tokens);
        serverObs.set(name, list2);
      }
    }
  }
  const days: ContextSizeDay[] = [...dayMap.keys()].sort().map((day) => {
    const rows = dayMap.get(day) as Row[];
    const fields = {} as ContextSizeDay['fields'];
    for (const f of SIZE_FIELDS) {
      const values: number[] = [];
      for (const r of rows) {
        const cu = isObj(r.raw.contextUsage) ? r.raw.contextUsage : {};
        const v = num(cu[f]);
        if (v !== undefined) values.push(v);
      }
      fields[f] = {
        median: values.length === 0 ? null : median(values),
        max: values.length === 0 ? null : Math.max(...values),
        rows: { obtained: values.length, missing: rows.length - values.length },
      };
    }
    return { day, rows: rows.length, fields };
  });
  const servers = [...serverObs.entries()]
    .map(([name, v]) => ({
      name,
      observations: v.length,
      medianTokens: median(v),
      maxTokens: Math.max(...v),
    }))
    .sort(
      (a, b) =>
        b.medianTokens - a.medianTokens ||
        b.maxTokens - a.maxTokens ||
        a.name.localeCompare(b.name),
    );

  // ---- 6. 結べない増分 ----
  windows.sort((a, b) => a.start - b.start);
  const prefixMaxEnd: number[] = [];
  let runningMax = -Infinity;
  for (const w of windows) {
    runningMax = Math.max(runningMax, w.end);
    prefixMaxEnd.push(runningMax);
  }
  const linked = (atMs: number): boolean => {
    let lo = 0;
    let hi = windows.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((windows[mid] as { start: number }).start <= atMs) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return idx >= 0 && (prefixMaxEnd[idx] as number) >= atMs;
  };
  let unlinked = 0;
  let cacheReadUnlinked = 0;
  let cacheReadAllIncr = 0;
  let cacheReadIncrRows = 0;
  const unlinkedByLayer: Record<string, { increments: number; unlinked: number }> = {};
  for (const inc of increments) {
    const isLinked = linked(inc.row.atMs);
    const slot = (unlinkedByLayer[inc.layer] ??= { increments: 0, unlinked: 0 });
    slot.increments += 1;
    if (!isLinked) {
      unlinked += 1;
      slot.unlinked += 1;
    }
    if (inc.cacheRead !== undefined) {
      cacheReadAllIncr += inc.cacheRead;
      cacheReadIncrRows += 1;
      if (!isLinked) cacheReadUnlinked += inc.cacheRead;
    }
  }

  // ---- 7. 日別 ----
  const notices: string[] = [];
  let dailyComparison: DiagnosticsAnalysis['dailyComparison'];
  if (ledger.header.state !== 'read') {
    dailyComparison = {
      state: 'not_joined',
      reason:
        ledger.header.state === 'none'
          ? '台帳（--usage）が無いので並べない'
          : '台帳が読めないので並べない',
    };
  } else if (timeZone.state === 'invalid') {
    dailyComparison = {
      state: 'not_joined',
      reason: `時間帯名が不正（${timeZone.given}）なので並べない。${timeZone.reason}`,
    };
  } else if (timeZone.state === 'unknown') {
    dailyComparison = {
      state: 'not_joined',
      reason:
        '台帳の TZ が不明なので並べない（台帳の date はサーバのローカル暦日、日誌は UTC。--ledger-tz <IANA> で渡せる。推測しない）',
    };
  } else {
    const tz = timeZone.name;
    const jDay = new Map<string, { acc: TokenAcc }>();
    for (const inc of increments) {
      const d = dateInTimeZone(inc.row.atMs, tz);
      const slot = jDay.get(d) ?? { acc: new TokenAcc() };
      slot.acc.add(tokensOfTurnUsage(inc.row.raw));
      jDay.set(d, slot);
    }
    const periodFirst = Number.isFinite(first) ? dateInTimeZone(first, tz) : null;
    const periodLast = Number.isFinite(last) ? dateInTimeZone(last, tz) : null;
    const allDates = [...new Set([...ledger.days.keys(), ...jDay.keys()])].sort();
    const rows = allDates.map((date): DailyComparisonRow => {
      const l = ledger.days.get(date) ?? null;
      const j = jDay.get(date);
      const js = j?.acc.stat();
      const inRange =
        periodFirst !== null && periodLast !== null && date >= periodFirst && date <= periodLast;
      const journal: DailyComparisonRow['journal'] =
        js === undefined
          ? inRange
            ? { turns: 0, cacheRead: null, cacheCreation: null, input: null, output: null }
            : null
          : {
              turns: js.rows,
              cacheRead: js.sums.cacheRead,
              cacheCreation: js.sums.cacheCreation,
              input: js.sums.input,
              output: js.sums.output,
            };
      const lcr = l?.cacheReadInputTokens ?? null;
      const jcr = journal?.cacheRead ?? null;
      return {
        date,
        ledger: l,
        journal,
        ledgerOverJournalCacheRead: lcr === null || jcr === null || jcr === 0 ? null : lcr / jcr,
        journalEdgeDay: inRange && (date === periodFirst || date === periodLast),
      };
    });
    dailyComparison = { state: 'joined', timeZone: tz, rows };
  }

  // 台帳の二重計上の期間（#5402 より前）にかかるなら注記
  if (ledger.header.state === 'read') {
    const inPeriod = ledger.rawRows.filter(
      (r) => r.date >= LEDGER_DOUBLE_COUNT_PERIOD.from && r.date <= LEDGER_DOUBLE_COUNT_PERIOD.to,
    );
    if (inPeriod.length > 0) {
      const cloneSession = inPeriod.filter((r) => r.layer === 'clone' && r.site === 'session');
      const sum = cloneSession.reduce((s, r) => s + (r.cacheRead ?? 0), 0);
      notices.push(
        `台帳の日付が ${LEDGER_DOUBLE_COUNT_PERIOD.from}〜${LEDGER_DOUBLE_COUNT_PERIOD.to}（#5402 より前の期間）にかかっている。` +
          `この期間は台帳の clone/session の cache_read が約 ${LEDGER_DOUBLE_COUNT_APPROX_CACHE_READ.toLocaleString('en-US')} 多い（二重計上）。` +
          `入力の台帳のこの期間の clone/session の cache_read 合計は ${sum.toLocaleString('en-US')}。` +
          '台帳の絶対値は日誌を主として読み直すこと',
      );
    }
  }
  if (timeZone.state === 'known' && timeZone.ignoredArgument !== undefined) {
    notices.push(
      `台帳が申告した時間帯 ${timeZone.name} を使った。--ledger-tz の ${timeZone.ignoredArgument} は使っていない`,
    );
  }

  const sessionCounts = [...compactionBySession.values()];
  return {
    header: {
      period:
        Number.isFinite(first) && Number.isFinite(last)
          ? { first: new Date(first).toISOString(), last: new Date(last).toISOString() }
          : null,
      lines: journal.lines,
      invalidLines: journal.invalidLines,
      countsByType,
      legacy: {
        turnTimingWithoutTokens: timingWithoutTokens,
        contextUsageWithoutSizeFields: contextWithoutSize,
        turnUsageWithoutCacheFields: usageWithoutCache,
      },
      contextUsageErrorRows: contextErrorRows,
      timeZone,
      ledger: ledger.header,
    },
    cache: {
      fromTurnTiming: timingAcc.stat(),
      fromTurnUsage: {
        overall: overall.stat(),
        byLayer: groupStat(byLayer),
        bySite: groupStat(bySite),
        byLayerSite: groupStat(byLayerSite),
        excludedResetRows,
      },
    },
    triggers: {
      byBundle: triggerStats(bundleAcc),
      bySingleTrigger: triggerStats(singleAcc),
      triggersMissingRows: triggersMissing,
      batchSize: {
        distribution: [...batch.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([batchSize, count]) => ({ batchSize, count })),
        rows: { obtained: timing.length - batchMissing, missing: batchMissing },
      },
      managerMessageIntervals: {
        turns: mmTurns,
        withoutBoundary: mmWithoutBoundary,
        intervals: gaps.length,
        under60s: under(60_000),
        under5min: under(300_000),
        under30min: under(1_800_000),
      },
    },
    perTurn: {
      byLayer: layerSiteList(byLayer),
      bySite: layerSiteList(bySite),
      topManagers: {
        limit: topN,
        totalManagers: managers.length,
        rows: managers.slice(0, topN),
      },
    },
    promptSize: {
      days,
      mcpServers: {
        limit: topN,
        totalServers: servers.length,
        rows: servers.slice(0, topN),
        rowsWithoutField: serversWithoutField,
      },
    },
    compactionsAndResets: {
      compactions: {
        turnUsageRowsWithCompactions: compactionRows,
        turnUsageCompactions: compactionCount,
        turnTimingCompactions: {
          sum: timingCompactionRows === 0 ? null : timingCompactionSum,
          rows: { obtained: timingCompactionRows, missing: timing.length - timingCompactionRows },
        },
        perSession: {
          sessions: sessionCounts.length,
          sessionsWithCompaction: sessionCounts.filter((c) => c > 0).length,
          max: sessionCounts.length === 0 ? null : Math.max(...sessionCounts),
          mean:
            sessionCounts.length === 0
              ? null
              : sessionCounts.reduce((s, c) => s + c, 0) / sessionCounts.length,
          rowsWithoutSessionId,
        },
      },
      journalReset: {
        turnUsageRows: usageRows.length,
        resetRows,
        resetCacheRead: resetCacheReadRows === 0 ? null : resetCacheRead,
        allCacheRead: allCacheReadRows === 0 ? null : allCacheRead,
        cacheReadShare:
          allCacheReadRows === 0 || allCacheRead === 0 ? null : resetCacheRead / allCacheRead,
      },
      ledgerResets: ledger.resets,
    },
    unlinkedIncrements: {
      increments: increments.length,
      unlinked,
      unlinkedShare: share(unlinked, increments.length),
      cacheReadUnlinked: cacheReadIncrRows === 0 ? null : cacheReadUnlinked,
      cacheReadAll: cacheReadIncrRows === 0 ? null : cacheReadAllIncr,
      cacheReadShare:
        cacheReadIncrRows === 0 || cacheReadAllIncr === 0
          ? null
          : cacheReadUnlinked / cacheReadAllIncr,
      turnTimingWindows: windows.length,
      turnTimingWithoutBoundary: timingWithoutBoundary,
      byLayer: unlinkedByLayer,
    },
    dailyComparison,
    notices,
  };
}
