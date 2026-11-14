// 診断の要約: 別の alteroid へ送る「本体」の型（`diagnosticsSummarySchema`）と、日誌・台帳から作る純関数（`buildDiagnosticsSummary`）。
// 送ってよい内容だけを許可制で持つ: 文字列の欄は列挙型か「許可パターン＋最大長」だけ。向こうの持ち主の記憶・会話・鍵は載らない。
// 載せないもの: `context_usage.error`・`categories[].name`・`messageBreakdown.toolsByName[].name`・`slowestSql`・`http_timing` の中身・依頼・報告・会話の文面。
// 集計の本体は `diagnostics-analysis.ts`（PR-2）を再利用する。ここで集計を複製しない。
// ブラウザバンドルへ入れない: zod を使う。`index.ts`（バレル）からだけ出し、`apps/web` は値で import できない（eslint）。
import {
  analyzeDiagnostics,
  type DiagnosticsAnalysis,
  type ParsedJournal,
  type TokenStat,
} from './diagnostics-analysis.js';
import { z } from 'zod';

import { secretPatternsInBody } from './redact.js';
import {
  inboxEventSchema,
  journalEntrySchema,
  type InboxEventType,
  type JournalEntry,
} from './schema.js';
import { USAGE_LAYERS, USAGE_SITES } from './usage-format.js';

// ---- 定数 ----

export const DIAGNOSTICS_SUMMARY_SCHEMA_VERSION = 1;
/** JSON にしたときの上限（バイト）。スキーマ側と生成側の両方で縛る */
export const DIAGNOSTICS_SUMMARY_MAX_BYTES = 16 * 1024;
export const DIAGNOSTICS_SUMMARY_DEFAULT_TOP = 10;
export const DIAGNOSTICS_SUMMARY_MAX_TOP = 20;
export const DIAGNOSTICS_SUMMARY_MCP_SERVERS = 5;
const MAX_PROMPT_DAYS = 31;
const MAX_BATCH_SIZES = 12;

/** managerId・sessionId・conversationId 相当の ID */
export const SUMMARY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
/** 集計が名前を 64 字で切る（`…` を足す）ので、生成側が通す長さの上限はこちら */
const SUMMARY_ID_BUILD_MAX = 64;
/** MCP サーバ名。ID と同じ文字種で最大 64 字 */
export const SUMMARY_MCP_SERVER_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
/** IANA の TZ 名 */
export const SUMMARY_TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

const closedSet = <T extends string>(values: readonly T[]): [T, ...T[]] =>
  values as unknown as [T, ...T[]];

/** 日誌の行の型。スキーマの定義そのものから取る（手で写さない） */
export const SUMMARY_JOURNAL_TYPES: readonly JournalEntry['type'][] =
  journalEntrySchema.options.map((option) => option.shape.type.value);
/** 起点の種類名（inbox イベントの型名）。閉じた集合なので列挙型にする */
export const SUMMARY_TRIGGER_KINDS: readonly InboxEventType[] = inboxEventSchema.options.map(
  (option) => option.shape.type.value,
);

// ---- スキーマ ----

// 未知の欄は拒否する（`.strict()`）。すべてのオブジェクトをこれで作る
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative().nullable();
const isoDateTime = z.iso.datetime();
const idString = z.string().regex(SUMMARY_ID_PATTERN).max(80);
const layerEnum = z.enum(closedSet<string>(USAGE_LAYERS));
const siteEnum = z.enum(closedSet<string>(USAGE_SITES));
const triggerEnum = z.enum(closedSet<string>(SUMMARY_TRIGGER_KINDS));
const journalTypeEnum = z.enum(closedSet<string>(SUMMARY_JOURNAL_TYPES));

/** 比率は「値」と「取れなかった行数」。取れなければ 0 ではなく null */
const ratio = strictObject({ value: metric, missingRows: count });

const tokenSummarySchema = strictObject({
  rows: count,
  cacheReadSum: metric,
  cacheCreationSum: metric,
  readOverCreation: ratio,
  readRate: ratio,
});
export type TokenSummary = z.infer<typeof tokenSummarySchema>;

const shareCount = strictObject({ count, share: metric });

const resetsLedgerSchema = z.discriminatedUnion('state', [
  strictObject({
    state: z.literal('unavailable'),
    reason: z.enum(['ledger_not_given', 'ledger_unreadable', 'resets_absent']),
  }),
  strictObject({
    state: z.literal('known'),
    baselines: count,
    total: count,
    rows: z
      .array(
        strictObject({
          layer: layerEnum,
          managerId: idString,
          resets: count,
          lastResetAt: isoDateTime.nullable(),
        }),
      )
      .max(DIAGNOSTICS_SUMMARY_MAX_TOP),
  }),
]);

const ledgerTimeZoneSchema = z.discriminatedUnion('state', [
  strictObject({
    state: z.literal('known'),
    name: z.string().regex(SUMMARY_TIME_ZONE_PATTERN),
    source: z.enum(['usage', 'argument']),
  }),
  strictObject({ state: z.literal('unavailable'), reason: z.enum(['not_declared', 'invalid']) }),
]);

const sizeField = strictObject({ median: metric, max: metric, missingRows: count });

export const TRUNCATED_SECTIONS = [
  'promptSizeDays',
  'mcpServers',
  'batchSize',
  'ledgerResets',
  'topManagers',
] as const;

const diagnosticsSummaryBase = strictObject({
  schemaVersion: z.literal(DIAGNOSTICS_SUMMARY_SCHEMA_VERSION),
  generatedAt: isoDateTime,
  /** 日誌の最初と最後の行の時刻（UTC）。行が無ければ null */
  period: strictObject({ start: isoDateTime, end: isoDateTime }).nullable(),
  /** 16 KiB に収めるために畳んだ節。空なら畳んでいない */
  truncated: z.array(z.enum(TRUNCATED_SECTIONS)).max(TRUNCATED_SECTIONS.length),
  rows: strictObject({
    lines: count,
    invalidLines: count,
    byType: z
      .array(strictObject({ type: journalTypeEnum, count }))
      .max(SUMMARY_JOURNAL_TYPES.length),
    legacy: strictObject({
      turnTimingWithoutTokens: count,
      contextUsageWithoutSizeFields: count,
      turnUsageWithoutCacheFields: count,
    }),
    contextUsageErrorRows: count,
  }),
  /** 許可パターン・列挙に合わず、値を載せずに落としたものの件数（値そのものは載せない） */
  droppedValues: strictObject({
    journalTypeRows: count,
    triggerRows: count,
    managerIdRows: count,
    layerOrSiteRows: count,
    mcpServerObservations: count,
    resetRows: count,
  }),
  ledger: z.discriminatedUnion('state', [
    strictObject({ state: z.literal('none') }),
    strictObject({ state: z.literal('unreadable') }),
    strictObject({ state: z.literal('read'), rows: count, skippedRows: count }),
  ]),
  ledgerDateTimeZone: ledgerTimeZoneSchema,
  cache: strictObject({
    /** turn_timing.tokens 由来（ターン単位。層・場所は行に無いので全体だけ） */
    fromTurnTiming: tokenSummarySchema,
    /** turn_usage.models 由来（増分。reset 行は除く） */
    fromTurnUsage: strictObject({
      overall: tokenSummarySchema,
      byLayer: z.array(strictObject({ layer: layerEnum, stat: tokenSummarySchema })).max(2),
      bySite: z.array(strictObject({ site: siteEnum, stat: tokenSummarySchema })).max(3),
      byLayerSite: z
        .array(strictObject({ layer: layerEnum, site: siteEnum, stat: tokenSummarySchema }))
        .max(6),
      excludedResetRows: count,
    }),
  }),
  triggers: strictObject({
    byKind: z
      .array(
        strictObject({
          kind: triggerEnum,
          turns: count,
          cacheReadSum: metric,
          share: metric,
        }),
      )
      .max(SUMMARY_TRIGGER_KINDS.length),
    rowsWithoutTriggers: count,
    batchSize: strictObject({
      distribution: z.array(strictObject({ batchSize: count, count })).max(MAX_BATCH_SIZES),
      missingRows: count,
    }),
    managerMessageIntervals: strictObject({
      turns: count,
      intervals: count,
      under60s: shareCount,
      under5min: shareCount,
      under30min: shareCount,
    }),
  }),
  perTurn: strictObject({
    byLayer: z
      .array(
        strictObject({
          layer: layerEnum,
          turns: count,
          cacheReadPerTurn: metric,
          outputPerTurn: metric,
        }),
      )
      .max(2),
    bySite: z
      .array(
        strictObject({
          site: siteEnum,
          turns: count,
          cacheReadPerTurn: metric,
          outputPerTurn: metric,
        }),
      )
      .max(3),
    topManagers: strictObject({
      limit: z.number().int().min(1).max(DIAGNOSTICS_SUMMARY_MAX_TOP),
      totalManagers: count,
      rows: z
        .array(
          strictObject({
            managerId: idString,
            layer: layerEnum,
            turns: count,
            cacheRead: metric,
          }),
        )
        .max(DIAGNOSTICS_SUMMARY_MAX_TOP),
    }),
  }),
  promptSize: strictObject({
    days: z
      .array(
        strictObject({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          rows: count,
          systemPromptTokens: sizeField,
          memoryFileTokens: sizeField,
          mcpToolTokens: sizeField,
          totalTokens: sizeField,
        }),
      )
      .max(MAX_PROMPT_DAYS),
    mcpServers: strictObject({
      totalServers: count,
      rowsWithoutField: count,
      rows: z
        .array(
          strictObject({
            name: z.string().regex(SUMMARY_MCP_SERVER_PATTERN).max(64),
            observations: count,
            medianTokens: z.number().nonnegative(),
            maxTokens: z.number().nonnegative(),
          }),
        )
        .max(DIAGNOSTICS_SUMMARY_MCP_SERVERS),
    }),
  }),
  compactions: strictObject({
    turnUsageRowsWithCompactions: count,
    turnUsageCompactions: count,
    /** turn_timing.compactions.count の合計。1行も取れなければ null */
    turnTimingCompactions: strictObject({ sum: metric, missingRows: count }),
  }),
  resets: strictObject({
    /** 台帳の層 × マネージャーごとの数え直し。unavailable（取れない）と known で rows が [] を区別する */
    ledger: resetsLedgerSchema,
    journal: strictObject({
      turnUsageRows: count,
      resetRows: count,
      resetCacheRead: metric,
      allCacheRead: metric,
      cacheReadShare: metric,
    }),
  }),
});

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export const diagnosticsSummarySchema = diagnosticsSummaryBase.superRefine((value, ctx) => {
  if (jsonByteLength(value) > DIAGNOSTICS_SUMMARY_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `JSON にしたとき ${DIAGNOSTICS_SUMMARY_MAX_BYTES} バイトを超える`,
    });
  }
});

export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;

// ---- 秘密の最後の防壁 ----

// 既存の秘密パターン（`secretPatternsInBody`）に、固有の接頭辞の「接頭辞だけ」と長い塊を足す。
// `mgr-<uuid>` の managerId（40 字・ハイフン区切り）を誤検出しないよう、塊は `-` を含めない
const EXTRA_SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['integration-key-prefix', /altk_/i],
  ['anthropic-key-prefix', /sk-ant-/i],
  ['github-token-prefix', /\bgh[pousr]_/],
  ['github-pat-prefix', /github_pat_/],
  ['bearer-prefix', /Bearer\s/i],
  ['private-key-pem-header', /-----BEGIN /],
  ['long-hex', /[0-9A-Fa-f]{32,}/],
  ['long-base64', /[A-Za-z0-9+/_]{40,}={0,2}/],
];

/** 当たった規則の名前だけを返す（見つかった文字列は返さない） */
export function findSecretPatterns(json: string, env?: NodeJS.ProcessEnv): string[] {
  const hits: string[] = [...secretPatternsInBody(json, env)];
  for (const [name, pattern] of EXTRA_SECRET_PATTERNS) if (pattern.test(json)) hits.push(name);
  return hits;
}

/** 要約に秘密らしいものが見つかった。生成を断る（伏せて続行しない）。メッセージに値は含めない */
export class DiagnosticsSummarySecretError extends Error {
  readonly patterns: readonly string[];
  constructor(patterns: readonly string[]) {
    super(
      `診断の要約に秘密らしい文字列が見つかったので生成を断った（規則: ${patterns.join(', ')}）。入力の日誌・台帳を確かめること`,
    );
    this.name = 'DiagnosticsSummarySecretError';
    this.patterns = patterns;
  }
}

// ---- 生成 ----

export interface BuildDiagnosticsSummaryInput {
  journal: ParsedJournal;
  /** `usage --json` の中身（parse したもの） */
  usage?: unknown;
}

export interface BuildDiagnosticsSummaryOptions {
  ledgerTz?: string;
  /** managerId の上位の件数。既定 10、上限 20 */
  topN?: number;
  now?: Date;
  /** 環境変数の鍵の値が要約に紛れていないかの照合に使う。既定は使わない（純関数のまま） */
  env?: NodeJS.ProcessEnv;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const UNKNOWN_KEY = '(取れない)';
const journalTypeSet: ReadonlySet<string> = new Set(SUMMARY_JOURNAL_TYPES);
const triggerSet: ReadonlySet<string> = new Set(SUMMARY_TRIGGER_KINDS);
const layerSet: ReadonlySet<string> = new Set(USAGE_LAYERS);
const siteSet: ReadonlySet<string> = new Set(USAGE_SITES);

const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= SUMMARY_ID_BUILD_MAX &&
  SUMMARY_ID_PATTERN.test(value);
const validMcpName = (value: unknown): value is string =>
  typeof value === 'string' && SUMMARY_MCP_SERVER_PATTERN.test(value);

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

interface Sanitized {
  journal: ParsedJournal;
  usage: unknown;
  droppedJournalTypeRows: number;
  droppedTriggerRows: number;
}

/**
 * 集計へ渡す前に、自由な形の文字列を許可パターンで落とす。
 * 落とす（断らない）: 1つの欄の不正で診断全体を失わないため。落とした値は「取れない」側へ寄り、件数だけを `droppedValues` に残す。
 * 値が許可パターンを通って秘密らしいときだけ、生成後の走査が断る
 */
function sanitizeInput(input: BuildDiagnosticsSummaryInput): Sanitized {
  let droppedJournalTypeRows = 0;
  let droppedTriggerRows = 0;
  const rows = input.journal.rows.map((row) => {
    if (!journalTypeSet.has(row.type)) {
      droppedJournalTypeRows += 1;
      // 型名が集計キーに出ないよう、どの型にも一致しない印へ置く
      return { ...row, type: UNKNOWN_KEY, raw: {} };
    }
    const raw: Obj = { ...row.raw };
    if (raw.managerId !== undefined && !validId(raw.managerId)) delete raw.managerId;
    if (raw.triggers !== undefined) {
      const triggers = raw.triggers;
      if (
        !Array.isArray(triggers) ||
        !triggers.every((t) => typeof t === 'string' && triggerSet.has(t))
      ) {
        droppedTriggerRows += 1;
        delete raw.triggers;
      }
    }
    // 自由文の欄は集計が読まないが、紛れ込みを断つために入口でも消す
    delete raw.error;
    if (isObj(raw.contextUsage)) {
      const cu: Obj = { ...raw.contextUsage };
      delete cu.error;
      delete cu.categories;
      delete cu.messageBreakdown;
      if (Array.isArray(cu.mcpToolsByServer)) {
        cu.mcpToolsByServer = cu.mcpToolsByServer.map((s) =>
          isObj(s) && validMcpName(s.name)
            ? { name: s.name, tokens: s.tokens }
            : { tokens: isObj(s) ? s.tokens : undefined },
        );
      }
      // `error` を持つ行は集計が数だけ数える。消したので持っていた印だけ残す
      if (isObj(raw.contextUsage) && raw.contextUsage.error !== undefined) cu.error = true;
      raw.contextUsage = cu;
    }
    return { ...row, raw };
  });
  let usage = input.usage;
  if (isObj(usage) && Array.isArray(usage.resets)) {
    usage = {
      ...usage,
      resets: usage.resets.map((r) =>
        isObj(r)
          ? {
              layer: layerSet.has(r.layer as string) ? r.layer : undefined,
              managerId: validId(r.managerId) ? r.managerId : undefined,
              resets: r.resets,
              lastResetAt: isoOrNull(r.lastResetAt) ?? undefined,
            }
          : r,
      ),
    };
  }
  return {
    journal: { ...input.journal, rows },
    usage,
    droppedJournalTypeRows,
    droppedTriggerRows,
  };
}

function tokenSummary(stat: TokenStat): TokenSummary {
  return {
    rows: stat.rows,
    cacheReadSum: stat.sums.cacheRead,
    cacheCreationSum: stat.sums.cacheCreation,
    readOverCreation: {
      value: stat.readOverCreation.value,
      missingRows: stat.readOverCreation.rows.missing,
    },
    readRate: { value: stat.readRate.value, missingRows: stat.readRate.rows.missing },
  };
}

function resolveTopN(topN: number | undefined): number {
  const value = topN ?? DIAGNOSTICS_SUMMARY_DEFAULT_TOP;
  if (!Number.isInteger(value) || value < 1 || value > DIAGNOSTICS_SUMMARY_MAX_TOP) {
    throw new RangeError(`topN は 1〜${DIAGNOSTICS_SUMMARY_MAX_TOP} の整数`);
  }
  return value;
}

type Draft = z.input<typeof diagnosticsSummaryBase>;

function assemble(
  analysis: DiagnosticsAnalysis,
  sanitized: Sanitized,
  topN: number,
  generatedAt: string,
): Draft {
  const { header } = analysis;
  const fromUsage = analysis.cache.fromTurnUsage;
  const known = <K extends string>(set: ReadonlySet<string>, key: string): key is K => set.has(key);

  // ---- 行の型 ----
  const byType = Object.entries(header.countsByType)
    .filter(([type]) => journalTypeSet.has(type))
    .map(([type, n]) => ({ type, count: n }))
    .sort((a, b) => a.type.localeCompare(b.type));

  // ---- キャッシュ（閉じた集合に入らない層・場所は載せず件数に寄せる） ----
  let layerOrSiteRows = 0;
  const layerRows = Object.entries(fromUsage.byLayer);
  const siteRows = Object.entries(fromUsage.bySite);
  for (const [key, stat] of [...layerRows, ...siteRows])
    if (key === UNKNOWN_KEY) layerOrSiteRows += stat.rows;
  const byLayer = layerRows
    .filter(([key]) => known(layerSet, key))
    .map(([layer, stat]) => ({ layer, stat: tokenSummary(stat) }));
  const bySite = siteRows
    .filter(([key]) => known(siteSet, key))
    .map(([site, stat]) => ({ site, stat: tokenSummary(stat) }));
  const byLayerSite = Object.entries(fromUsage.byLayerSite).flatMap(([key, stat]) => {
    const [layer, site] = key.split('/');
    return layer !== undefined && site !== undefined && layerSet.has(layer) && siteSet.has(site)
      ? [{ layer, site, stat: tokenSummary(stat) }]
      : [];
  });

  // ---- 起点 ----
  const byKind = analysis.triggers.bySingleTrigger
    .filter((t) => triggerSet.has(t.key))
    .map((t) => ({ kind: t.key, turns: t.turns, cacheReadSum: t.cacheReadSum, share: t.share }));
  const batchAll = analysis.triggers.batchSize.distribution;
  const batchKept = [...batchAll]
    .sort((a, b) => b.count - a.count || a.batchSize - b.batchSize)
    .slice(0, MAX_BATCH_SIZES)
    .sort((a, b) => a.batchSize - b.batchSize);
  const intervals = analysis.triggers.managerMessageIntervals;

  // ---- 層・場所・委譲 ----
  const turnList = <K extends 'layer' | 'site'>(
    list: Array<{ key: string; turns: number; stat: TokenStat }>,
    name: K,
    set: ReadonlySet<string>,
  ) =>
    list
      .filter((e) => set.has(e.key))
      .map((e) => ({
        [name]: e.key,
        turns: e.turns,
        cacheReadPerTurn: e.stat.perTurn.cacheRead,
        outputPerTurn: e.stat.perTurn.output,
      }));
  const managerRows = analysis.perTurn.topManagers.rows;
  const droppedManagers = managerRows.filter((m) => m.managerId === UNKNOWN_KEY);
  const validManagers = managerRows.filter(
    (m) => m.managerId !== UNKNOWN_KEY && known(layerSet, m.layer),
  );

  // ---- プロンプトの大きさ ----
  const days = analysis.promptSize.days.map((d) => {
    const field = (name: keyof typeof d.fields) => ({
      median: d.fields[name].median,
      max: d.fields[name].max,
      missingRows: d.fields[name].rows.missing,
    });
    return {
      day: d.day,
      rows: d.rows,
      systemPromptTokens: field('systemPromptTokens'),
      memoryFileTokens: field('memoryFileTokens'),
      mcpToolTokens: field('mcpToolTokens'),
      totalTokens: field('totalTokens'),
    };
  });
  const serverRows = analysis.promptSize.mcpServers.rows;
  const droppedServers = serverRows.filter((s) => s.name === UNKNOWN_KEY);
  const validServers = serverRows.filter((s) => s.name !== UNKNOWN_KEY);

  // ---- 数え直し ----
  const ledgerResets = analysis.compactionsAndResets.ledgerResets;
  let resetsLedger: z.input<typeof resetsLedgerSchema>;
  let droppedResetRows = 0;
  if (ledgerResets.state === 'unavailable') {
    resetsLedger = {
      state: 'unavailable',
      reason:
        header.ledger.state === 'none'
          ? 'ledger_not_given'
          : header.ledger.state === 'unreadable'
            ? 'ledger_unreadable'
            : 'resets_absent',
    };
  } else {
    const valid = ledgerResets.rows.filter(
      (r) => r.managerId !== UNKNOWN_KEY && r.layer !== UNKNOWN_KEY,
    );
    droppedResetRows = ledgerResets.rows.length - valid.length;
    resetsLedger = {
      state: 'known',
      baselines: ledgerResets.baselines,
      total: ledgerResets.total,
      rows: [...valid]
        .sort((a, b) => b.resets - a.resets || a.managerId.localeCompare(b.managerId))
        .slice(0, DIAGNOSTICS_SUMMARY_MAX_TOP)
        .map((r) => ({
          layer: r.layer,
          managerId: r.managerId,
          resets: r.resets,
          lastResetAt: r.lastResetAt,
        })),
    };
  }
  const journalReset = analysis.compactionsAndResets.journalReset;
  const compactions = analysis.compactionsAndResets.compactions;

  const tz = header.timeZone;
  const ledgerDateTimeZone: z.input<typeof ledgerTimeZoneSchema> =
    tz.state === 'known'
      ? { state: 'known', name: tz.name, source: tz.source }
      : { state: 'unavailable', reason: tz.state === 'invalid' ? 'invalid' : 'not_declared' };

  return {
    schemaVersion: DIAGNOSTICS_SUMMARY_SCHEMA_VERSION,
    generatedAt,
    period: header.period === null ? null : { start: header.period.first, end: header.period.last },
    truncated: [],
    rows: {
      lines: header.lines,
      invalidLines: header.invalidLines,
      byType,
      legacy: header.legacy,
      contextUsageErrorRows: header.contextUsageErrorRows,
    },
    droppedValues: {
      journalTypeRows: sanitized.droppedJournalTypeRows,
      triggerRows: sanitized.droppedTriggerRows,
      managerIdRows: droppedManagers.reduce((s, m) => s + m.turns, 0),
      layerOrSiteRows,
      mcpServerObservations: droppedServers.reduce((s, m) => s + m.observations, 0),
      resetRows: droppedResetRows,
    },
    ledger:
      header.ledger.state === 'read'
        ? { state: 'read', rows: header.ledger.rows, skippedRows: header.ledger.skippedRows }
        : { state: header.ledger.state },
    ledgerDateTimeZone,
    cache: {
      fromTurnTiming: tokenSummary(analysis.cache.fromTurnTiming),
      fromTurnUsage: {
        overall: tokenSummary(fromUsage.overall),
        byLayer,
        bySite,
        byLayerSite,
        excludedResetRows: fromUsage.excludedResetRows,
      },
    },
    triggers: {
      byKind,
      rowsWithoutTriggers: analysis.triggers.triggersMissingRows,
      batchSize: {
        distribution: batchKept,
        missingRows: analysis.triggers.batchSize.rows.missing,
      },
      managerMessageIntervals: {
        turns: intervals.turns,
        intervals: intervals.intervals,
        under60s: intervals.under60s,
        under5min: intervals.under5min,
        under30min: intervals.under30min,
      },
    },
    perTurn: {
      byLayer: turnList(analysis.perTurn.byLayer, 'layer', layerSet) as never,
      bySite: turnList(analysis.perTurn.bySite, 'site', siteSet) as never,
      topManagers: {
        limit: topN,
        totalManagers: analysis.perTurn.topManagers.totalManagers - droppedManagers.length,
        rows: validManagers.slice(0, topN).map((m) => ({
          managerId: m.managerId,
          layer: m.layer,
          turns: m.turns,
          cacheRead: m.cacheRead,
        })),
      },
    },
    promptSize: {
      days: days.slice(-MAX_PROMPT_DAYS),
      mcpServers: {
        totalServers: analysis.promptSize.mcpServers.totalServers - droppedServers.length,
        rowsWithoutField: analysis.promptSize.mcpServers.rowsWithoutField,
        rows: validServers.slice(0, DIAGNOSTICS_SUMMARY_MCP_SERVERS).map((s) => ({
          name: s.name,
          observations: s.observations,
          medianTokens: s.medianTokens,
          maxTokens: s.maxTokens,
        })),
      },
    },
    compactions: {
      turnUsageRowsWithCompactions: compactions.turnUsageRowsWithCompactions,
      turnUsageCompactions: compactions.turnUsageCompactions,
      turnTimingCompactions: {
        sum: compactions.turnTimingCompactions.sum,
        missingRows: compactions.turnTimingCompactions.rows.missing,
      },
    },
    resets: {
      ledger: resetsLedger,
      journal: {
        turnUsageRows: journalReset.turnUsageRows,
        resetRows: journalReset.resetRows,
        resetCacheRead: journalReset.resetCacheRead,
        allCacheRead: journalReset.allCacheRead,
        cacheReadShare: journalReset.cacheReadShare,
      },
    },
  } satisfies Draft;
}

type Fold = {
  section: (typeof TRUNCATED_SECTIONS)[number];
  length: (d: Draft) => number;
  cut: (d: Draft, keep: number) => void;
};

// 畳む順（価値の低いものから）。各節を半分ずつ、空になるまで削ってから次の節へ進む
const FOLDS: readonly Fold[] = [
  {
    section: 'promptSizeDays',
    length: (d) => d.promptSize.days.length,
    cut: (d, keep) => {
      d.promptSize.days = keep === 0 ? [] : d.promptSize.days.slice(-keep);
    },
  },
  {
    section: 'mcpServers',
    length: (d) => d.promptSize.mcpServers.rows.length,
    cut: (d, keep) => {
      d.promptSize.mcpServers.rows = d.promptSize.mcpServers.rows.slice(0, keep);
    },
  },
  {
    section: 'batchSize',
    length: (d) => d.triggers.batchSize.distribution.length,
    cut: (d, keep) => {
      d.triggers.batchSize.distribution = d.triggers.batchSize.distribution.slice(0, keep);
    },
  },
  {
    section: 'ledgerResets',
    length: (d) => (d.resets.ledger.state === 'known' ? d.resets.ledger.rows.length : 0),
    cut: (d, keep) => {
      if (d.resets.ledger.state === 'known')
        d.resets.ledger.rows = d.resets.ledger.rows.slice(0, keep);
    },
  },
  {
    section: 'topManagers',
    length: (d) => d.perTurn.topManagers.rows.length,
    cut: (d, keep) => {
      d.perTurn.topManagers.rows = d.perTurn.topManagers.rows.slice(0, keep);
    },
  },
];

function foldToFit(draft: Draft, preTruncated: Array<(typeof TRUNCATED_SECTIONS)[number]>): void {
  const truncated = new Set(preTruncated);
  for (const fold of FOLDS) {
    while (jsonByteLength(draft) > DIAGNOSTICS_SUMMARY_MAX_BYTES && fold.length(draft) > 0) {
      fold.cut(draft, Math.floor(fold.length(draft) / 2));
      truncated.add(fold.section);
    }
  }
  draft.truncated = TRUNCATED_SECTIONS.filter((s) => truncated.has(s));
}

/**
 * 日誌の行と台帳の応答から、別の alteroid へ送る要約を作る。
 * 集計は `analyzeDiagnostics`（PR-2）を再利用する。出力は `diagnosticsSummarySchema` で parse して返し、
 * 落ちたら例外（黙って落とさない）。最後に JSON の文字列を秘密のパターンで走査し、見つかれば例外で断る
 */
export function buildDiagnosticsSummary(
  input: BuildDiagnosticsSummaryInput,
  options: BuildDiagnosticsSummaryOptions = {},
): DiagnosticsSummary {
  const topN = resolveTopN(options.topN);
  const sanitized = sanitizeInput(input);
  const analysis = analyzeDiagnostics(sanitized.journal, {
    usage: sanitized.usage,
    ...(options.ledgerTz === undefined ? {} : { ledgerTz: options.ledgerTz }),
    // 不正なキーを除いてから上位を切るので、集計側では切らない
    topN: Number.MAX_SAFE_INTEGER,
  });
  const generatedAt = (options.now ?? new Date()).toISOString();
  const draft = assemble(analysis, sanitized, topN, generatedAt);
  const pre: Array<(typeof TRUNCATED_SECTIONS)[number]> = [];
  if (analysis.promptSize.days.length > MAX_PROMPT_DAYS) pre.push('promptSizeDays');
  if (analysis.triggers.batchSize.distribution.length > MAX_BATCH_SIZES) pre.push('batchSize');
  foldToFit(draft, pre);
  const parsed = diagnosticsSummarySchema.parse(draft);
  const hits = findSecretPatterns(JSON.stringify(parsed), options.env);
  if (hits.length > 0) throw new DiagnosticsSummarySecretError(hits);
  return parsed;
}
