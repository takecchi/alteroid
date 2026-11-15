// クローンとマネージャーの会話（`exchange`）と、クローンのターンの入力の重さ（`turn_input`）を読んで、事実を並べる純関数。
// 読み取りのみ・通信なし・zod を import しない（行は構造として疑って読み、欄が無い・型が違う行は「取れない」に数える）。
// 実測と見積りを混ぜない: `turn_input` がある日・ターンは実測、無い所だけ固定の定数の長さから見積もる（同じターンを二重に数えない）。
// 取れない軸に 0 を置かない（`null` と理由）。表にするのは `diagnostics-conversation-format.ts`。
import {
  ORIGIN_NO_TASK_GUIDE,
  ORIGIN_TASK_GUIDE,
  REPORT_FOLLOW_UP_GUIDE,
} from './clone-batch-prompts.js';
import { DENIAL_ASK_AFTER_ANSWER_PARAGRAPH, DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE } from './classifier-denial-streak.js';
import { DENIAL_REPLY_ROUTE } from './denial-key.js';
import {
  CONVERSATION_KINDS,
  CONVERSATION_KIND_LABELS,
  DELIVERY_KINDS,
  MANAGER_REPORT_BODY_LIMIT,
  REPORT_FAMILY_KINDS,
  REPORT_NOTE_LABELS,
  classifyExchangeText,
  codePointLength,
  fullTextCharsOfNote,
  indicatorsOf,
  splitReportNotes,
  type ConversationKind,
  type ReportNoteKey,
  type TextIndicators,
} from './diagnostics-conversation-classify.js';
import type { Coverage, ParsedJournal } from './diagnostics-analysis.js';
import { READINGS_NOTICE, SITUATION_HEAD } from './situation.js';
import { NOTICE_KEYS, TEMPLATES } from './turn-input-observation.js';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// 集計キー・表示に出す名前から制御文字を除き、長さを切る（入力の自由文が出力へ紛れないように）
function safeKey(value: unknown, fallback = '(取れない)'): string {
  if (typeof value !== 'string' || value === '') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

// ---- 分布 ----

export interface ConversationDist {
  count: number;
  /** 1件も無ければ null（0 にしない） */
  sum: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
}

/** p90 は最近順位法（昇順の ceil(0.9 × n) 番目） */
export function conversationDistOf(values: readonly number[]): ConversationDist {
  if (values.length === 0) return { count: 0, sum: null, median: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return {
    count: sorted.length,
    sum: sorted.reduce((a, b) => a + b, 0),
    median,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

// ---- 結果の型 ----

export type AxisBasis = 'measured' | 'estimate' | 'text-derived' | 'unavailable';

export interface ConversationAxis {
  axis: string;
  basis: AxisBasis;
  source: string;
  note: string;
}

export interface ConversationManifestSummary {
  state: 'none' | 'unreadable' | 'read';
  reason: string | null;
  pulledAt: string | null;
  window: { since: string; until: string } | null;
  requestedExchanges: boolean | null;
  skippedNonManager: number | null;
  truncated: Array<{ part: string; reason: string; limit: number | null; rows: number | null }>;
  failures: Array<{ part: string; status: number | null; reason: string }>;
}

export interface ConversationCoverage {
  journal: { rows: number; turnInputRows: number; turnTimingRows: number };
  exchanges:
    | { state: 'none'; reason: string }
    | {
        state: 'read';
        rows: number;
        invalidLines: number;
        notExchangeRows: number;
        /** `with` が manager でない行。pull は保存しないので、pull の出力には無い */
        nonManagerRows: number;
        /** `text` が読めない行 */
        unreadableRows: number;
      };
  manifest: ConversationManifestSummary;
  axes: ConversationAxis[];
  /** 欠けているものの警告（人間が最初に読む） */
  warnings: string[];
}

export interface ShareRow {
  chars: number;
  /** この項目が読めた行の totalChars の合計に占める割合 */
  share: number | null;
  perTurnMedian: number | null;
  rows: Coverage;
}

export interface TurnInputGroup {
  key: string;
  turns: number;
  total: ConversationDist;
}

export interface TurnInputTopTurn {
  at: string;
  id: string | null;
  kind: string;
  triggers: string[];
  totalChars: number;
  noticesChars: number | null;
  situationChars: number | null;
  humanActionsChars: number | null;
  freshMemoryChars: number | null;
  bodyChars: number | null;
  framingChars: number | null;
  attachments: number | null;
}

export interface MeasuredSection {
  state: 'read';
  rows: number;
  /** totalChars が読めず集計に入れなかった turn_input 行 */
  unreadableRows: number;
  total: ConversationDist;
  byKind: TurnInputGroup[];
  byBundle: TurnInputGroup[];
  bySingleTrigger: TurnInputGroup[];
  occupancy: {
    totalCharsSum: number;
    /** 毎ターン付く「いまの全体」の注記（notices.situation） */
    situation: ShareRow;
    notices: Array<ShareRow & { key: string }>;
    humanActions: ShareRow;
    freshMemory: ShareRow;
    body: ShareRow;
    framing: ShareRow;
    /** bodyChars の内側の見方。signals は切る前の長さなので、切り詰めがあると body を超えうる（重ならない区分の足し算ではない） */
    bodyInside: { signals: ShareRow; templates: ShareRow; framing: ShareRow };
  };
  situationParts: {
    turnsWithSituation: number;
    turnsWithParts: number;
    situationChars: number;
    parts: Array<{
      key: string;
      chars: number;
      shareOfTotal: number | null;
      shareOfSituation: number | null;
      perTurnMedian: number | null;
    }>;
  };
  templates: Array<{
    name: string;
    turns: number;
    chars: number;
    shareOfTotal: number | null;
    /** 字数 ÷ いまの定数の長さ。定数の版が違う日誌では割り切れない */
    occurrences: number | null;
    divisible: boolean | null;
  }>;
  signals: {
    byKind: Array<{
      kind: string;
      count: number;
      /** 本文を持たない種類は束のとき 0 で書かれる（取れない）ので集計しない */
      chars: ConversationDist | null;
      overLimit: number;
    }>;
    byManager: {
      limit: number;
      totalManagers: number;
      rows: Array<{
        managerId: string;
        count: number;
        chars: number;
        byKind: Array<{ kind: string; count: number; chars: number }>;
      }>;
    };
    omitted: { rows: number; total: number };
    missingChars: number;
    overLimitTotal: number;
  };
  redelivery: { turns: number; withNotice: number; share: number | null; rows: Coverage };
  attachments: { sum: number | null; rows: Coverage };
  top: TurnInputTopTurn[];
}

export interface ExchangeKindRow {
  kind: ConversationKind;
  label: string;
  count: number;
  /** 本文（接頭辞と `[id…]` を除く）の字数 */
  chars: ConversationDist;
  /** 追加指示・返事・依頼は順序からの判定で、日誌に欄が無い */
  basis: 'text-derived' | 'derived-from-order';
}

export interface ExchangeTopText {
  kind: ConversationKind;
  label: string;
  at: string;
  chars: number;
  managerId: string | null;
  /** 先頭 80 字。伏せ字を掛けた後に切る */
  head: string;
}

export interface NoteShare {
  key: ReportNoteKey;
  label: string;
  rows: number;
  chars: number;
  /** 配達行の本文の字数の合計に占める割合 */
  shareOfDelivered: number | null;
}

export interface PatternStats {
  rows: number;
  rowsWithFence: number;
  rowsWithPathLike: number;
  rowsWithStack: number;
  rowsWithError: number;
  rowsWithToolResult: number;
  chars: number;
  lines: number;
  fenceCharShare: number | null;
  pathLikeLineShare: number | null;
  stackLineShare: number | null;
  errorLineShare: number | null;
  toolResultLineShare: number | null;
}

export interface ExchangesSection {
  state: 'read';
  byKind: ExchangeKindRow[];
  otherBreakdown: Array<{ key: string; count: number; chars: number }>;
  delivered: ConversationDist;
  byManager: {
    limit: number;
    totalManagers: number;
    withoutManagerId: { count: number; chars: number };
    rows: Array<{
      managerId: string;
      total: ConversationDist;
      byKind: Array<{ kind: ConversationKind; count: number; chars: number }>;
    }>;
  };
  top: ExchangeTopText[];
  /** 日誌の本文に残っている定型（本文の字面から数えた。プロンプト組み立て時に足される注記は含まない） */
  templatesInText: {
    deliveredChars: number;
    denialRoute: { rows: number; occurrences: number; chars: number; shareOfDelivered: number | null; shareOfDenialRows: number | null };
    denialAskAfterAnswer: { rows: number; chars: number; shareOfDelivered: number | null };
    notes: NoteShare[];
  };
}

export interface ContaminationSection {
  state: 'read';
  poolVsDelivery: {
    paired: number;
    unpairedPool: number;
    unpairedDelivery: number;
    /** 配達行 ÷ Pool 行（本文の字数）。1 より小さいほど縮めた */
    ratio: ConversationDist;
    /** 配達行の注記「全文 N 字」から読む途中の発言の量（N − 主文の字数。目安） */
    fullTextNote: {
      reportRows: number;
      rowsWithNote: number;
      noteShare: number | null;
      fullChars: ConversationDist;
      intermediateChars: ConversationDist;
      /** N が主文より小さい（読み取りが合わない）行 */
      inconsistent: number;
    };
  };
  overLimit: {
    limit: number;
    reportRows: number;
    rowsOverLimit: number;
    share: number | null;
    reportChars: ConversationDist;
  };
  patterns: { delivery: PatternStats; poolFull: PatternStats };
  attachments: {
    rowsWithAttachments: number;
    attachments: number;
    rowsWithRejected: number;
  };
  requestVsReport: {
    delegations: number;
    totalRequestChars: number | null;
    totalReportChars: number | null;
    overallRatio: number | null;
    perDelegationRatio: ConversationDist;
  };
}

export interface EstimateDay {
  day: string;
  basis: 'measured' | 'mixed' | 'estimated' | 'no-turns';
  timingNormalTurns: number;
  measuredNormalTurns: number;
  /** turn_timing のターンのうち turn_input で実測できなかった分（見積りに回した数） */
  estimatedNormalTurns: number;
  /** 見積り: 固定の2定数（`SITUATION_HEAD` と `READINGS_NOTICE`）× 見積りに回したターン数。可変の行は入れない下限 */
  situationFixedChars: number;
  /** 報告系の配達行のうち turn_input の合図で数えられなかった分。exchanges が無ければ null */
  remainderReportDeliveries: number | null;
  /** 見積り: 報告の案内（REPORT_FOLLOW_UP_GUIDE ＋ 起点の案内）。束なら案内は束に1つなので上寄り */
  reportGuideChars: { min: number; max: number } | null;
  /** 実測のターンが1つも無い日だけ、その日の報告系の配達行の本文の合計（プロンプトへ入る分）。混ざる日は行の対応が付かず null */
  deliveryBodyChars: number | null;
  framingShare: { min: number; max: number } | null;
}

export interface EstimateSection {
  state: 'read' | 'unavailable';
  reason: string | null;
  constants: {
    situationHeadChars: number;
    readingsNoticeChars: number;
    reportFollowUpGuideChars: number;
    originGuideChars: { min: number; max: number };
  };
  days: EstimateDay[];
  totals: {
    estimatedNormalTurns: number;
    situationFixedChars: number;
    reportGuideChars: { min: number; max: number } | null;
  };
  notEstimated: string[];
}

export interface ConversationAnalysis {
  coverage: ConversationCoverage;
  measured: MeasuredSection | { state: 'none'; reason: string };
  exchanges: ExchangesSection | { state: 'none'; reason: string };
  contamination: ContaminationSection | { state: 'none'; reason: string };
  estimate: EstimateSection;
}

export type ConversationExchangesInput =
  | { state: 'none'; reason: string }
  | { state: 'read'; parsed: ParsedJournal };

export type ConversationManifestInput =
  | { state: 'none'; reason: string }
  | { state: 'unreadable'; reason: string }
  | { state: 'read'; value: unknown };

export interface AnalyzeConversationInput {
  journal: ParsedJournal;
  exchanges: ConversationExchangesInput;
  manifest: ConversationManifestInput;
  topN: number;
  /** 表示する文面の直前に掛ける伏せ字（`createSecretRedactor().redact`）。必須: 掛け忘れを型で防ぐ */
  redact: (text: string) => string;
}

/** 先頭だけ見せる文字数 */
export const EXCHANGE_HEAD_CHARS = 80;

// manager_message の合図の kind（`turn_input.signals[].kind`）。書き手 `signalKindOf`（turn-input-observation.ts）は非公開で定数が無いので、
// ここに1か所だけ持つ。`diagnostics-conversation-analysis.test.ts` が `buildTurnInputEntry` の出力と突き合わせる
export const MANAGER_SIGNAL_KINDS = [
  'manager_report',
  'manager_question',
  'manager_confirmation',
  'denial_notice',
] as const;
// 本文を持たない合図（束のとき `signals[].chars` が 0 で書かれ、長さが取れない）。同じ理由で書き手の定数が無い
export const BODYLESS_SIGNAL_KINDS = ['timer', 'self_initiative', 'distill', 'daily_report'] as const;
// `signals[].chars` が 8000 を超えると頭だけがモデルに入るのは、報告系の合図だけ（質問・許可確認には上限が掛からない）
const SIGNAL_KINDS_WITH_BODY_LIMIT: readonly string[] = ['manager_report', 'denial_notice'];

// ---- turn_input（実測） ----

interface TurnRow {
  at: string;
  atMs: number;
  raw: Obj;
  totalChars: number;
  kind: string;
  triggers: string[];
}

function turnRowsOf(journal: ParsedJournal): { rows: TurnRow[]; unreadable: number } {
  const rows: TurnRow[] = [];
  let unreadable = 0;
  for (const row of journal.rows) {
    if (row.type !== 'turn_input') continue;
    const totalChars = num(row.raw.totalChars);
    if (totalChars === undefined) {
      unreadable += 1;
      continue;
    }
    const triggers = Array.isArray(row.raw.triggers)
      ? row.raw.triggers.filter((t): t is string => typeof t === 'string').map((t) => safeKey(t))
      : [];
    rows.push({
      at: row.at,
      atMs: row.atMs,
      raw: row.raw,
      totalChars,
      kind: safeKey(row.raw.kind),
      triggers,
    });
  }
  return { rows, unreadable };
}

function groupDist(rows: TurnRow[], keysOf: (row: TurnRow) => string[]): TurnInputGroup[] {
  const map = new Map<string, number[]>();
  for (const row of rows) {
    for (const key of new Set(keysOf(row))) {
      const list = map.get(key) ?? [];
      list.push(row.totalChars);
      map.set(key, list);
    }
  }
  return [...map.entries()]
    .map(([key, values]) => ({ key, turns: values.length, total: conversationDistOf(values) }))
    .sort((a, b) => (b.total.sum ?? 0) - (a.total.sum ?? 0) || a.key.localeCompare(b.key));
}

function shareRow(rows: TurnRow[], read: (row: TurnRow) => number | undefined): ShareRow {
  const values: number[] = [];
  let denominator = 0;
  for (const row of rows) {
    const v = read(row);
    if (v === undefined) continue;
    values.push(v);
    denominator += row.totalChars;
  }
  const dist = conversationDistOf(values);
  return {
    chars: dist.sum ?? 0,
    share: dist.sum === null ? null : ratio(dist.sum, denominator),
    perTurnMedian: dist.median,
    rows: { obtained: values.length, missing: rows.length - values.length },
  };
}

const noticeOf = (row: TurnRow, key: string): number | undefined =>
  isObj(row.raw.notices) ? (num(row.raw.notices[key]) ?? 0) : undefined;

function signalsOf(row: TurnRow): Obj[] | null {
  return Array.isArray(row.raw.signals) ? row.raw.signals.filter(isObj) : null;
}

function measuredSection(rows: TurnRow[], unreadable: number, topN: number): MeasuredSection {
  const total = conversationDistOf(rows.map((r) => r.totalChars));
  const totalCharsSum = total.sum ?? 0;

  const noticeKeys = new Set<string>(NOTICE_KEYS);
  for (const row of rows) {
    if (isObj(row.raw.notices)) for (const k of Object.keys(row.raw.notices)) noticeKeys.add(k);
  }
  const orderedNoticeKeys = [
    ...NOTICE_KEYS.filter((k) => noticeKeys.has(k)),
    ...[...noticeKeys].filter((k) => !(NOTICE_KEYS as readonly string[]).includes(k)).sort(),
  ];
  const situation = shareRow(rows, (r) => noticeOf(r, 'situation'));

  // 合図の内訳
  const signalAcc = new Map<string, { values: number[]; count: number; over: number }>();
  const managerAcc = new Map<string, Map<string, { count: number; chars: number }>>();
  let missingChars = 0;
  let omittedRows = 0;
  let omittedTotal = 0;
  const bodyInsideSignals: Array<number | undefined> = [];
  const bodyInsideTemplates: Array<number | undefined> = [];
  for (const row of rows) {
    const signals = signalsOf(row);
    const omitted = num(row.raw.signalsOmitted);
    if (omitted !== undefined && omitted > 0) {
      omittedRows += 1;
      omittedTotal += omitted;
    }
    if (signals === null) {
      bodyInsideSignals.push(undefined);
    } else {
      let sum = 0;
      for (const s of signals) {
        const kind = safeKey(s.kind);
        const chars = num(s.chars);
        const acc = signalAcc.get(kind) ?? { values: [], count: 0, over: 0 };
        acc.count += 1;
        if (chars === undefined) missingChars += 1;
        else {
          acc.values.push(chars);
          sum += chars;
          if (SIGNAL_KINDS_WITH_BODY_LIMIT.includes(kind) && chars > MANAGER_REPORT_BODY_LIMIT) {
            acc.over += 1;
          }
        }
        signalAcc.set(kind, acc);
        if ((MANAGER_SIGNAL_KINDS as readonly string[]).includes(kind)) {
          const managerId = safeKey(s.managerId, '(managerId なし)');
          const byKind = managerAcc.get(managerId) ?? new Map<string, { count: number; chars: number }>();
          const cell = byKind.get(kind) ?? { count: 0, chars: 0 };
          cell.count += 1;
          cell.chars += chars ?? 0;
          byKind.set(kind, cell);
          managerAcc.set(managerId, byKind);
        }
      }
      bodyInsideSignals.push(sum);
    }
    if (isObj(row.raw.templates)) {
      bodyInsideTemplates.push(
        Object.values(row.raw.templates).reduce<number>((a, v) => a + (num(v) ?? 0), 0),
      );
    } else {
      // `templates` は 0 のものを省く欄で、全部 0 のターンは欄ごと無い（0 字が実測）
      bodyInsideTemplates.push(0);
    }
  }
  const insideShare = (values: Array<number | undefined>): ShareRow => {
    const idx = { i: 0 };
    return shareRow(rows, () => values[idx.i++]);
  };

  const parts = new Map<string, number[]>();
  let turnsWithSituation = 0;
  let turnsWithParts = 0;
  let situationChars = 0;
  for (const row of rows) {
    const s = noticeOf(row, 'situation') ?? 0;
    if (s === 0) continue;
    turnsWithSituation += 1;
    situationChars += s;
    if (!isObj(row.raw.situationParts)) continue;
    turnsWithParts += 1;
    for (const [k, v] of Object.entries(row.raw.situationParts)) {
      const n = num(v);
      if (n === undefined) continue;
      const list = parts.get(safeKey(k)) ?? [];
      list.push(n);
      parts.set(safeKey(k), list);
    }
  }

  const templateAcc = new Map<string, { turns: number; chars: number }>();
  for (const row of rows) {
    if (!isObj(row.raw.templates)) continue;
    for (const [name, v] of Object.entries(row.raw.templates)) {
      const chars = num(v);
      if (chars === undefined || chars === 0) continue;
      const acc = templateAcc.get(safeKey(name)) ?? { turns: 0, chars: 0 };
      acc.turns += 1;
      acc.chars += chars;
      templateAcc.set(safeKey(name), acc);
    }
  }

  const managerRows = [...managerAcc.entries()]
    .map(([managerId, byKind]) => {
      const cells = [...byKind.entries()].map(([kind, c]) => ({ kind, ...c }));
      return {
        managerId,
        count: cells.reduce((a, c) => a + c.count, 0),
        chars: cells.reduce((a, c) => a + c.chars, 0),
        byKind: cells.sort((a, b) => a.kind.localeCompare(b.kind)),
      };
    })
    .sort((a, b) => b.chars - a.chars || a.managerId.localeCompare(b.managerId));

  const redeliveryRead = shareRow(rows, (r) => noticeOf(r, 'redelivery'));
  const redeliveryTurns = rows.filter((r) => (noticeOf(r, 'redelivery') ?? 0) > 0).length;
  const attachmentsRead = shareRow(rows, (r) => num(r.raw.attachments));

  const top = [...rows]
    .sort((a, b) => b.totalChars - a.totalChars || a.atMs - b.atMs)
    .slice(0, topN)
    .map((row): TurnInputTopTurn => {
      const noticesChars = isObj(row.raw.notices)
        ? Object.values(row.raw.notices).reduce<number>((a, v) => a + (num(v) ?? 0), 0)
        : null;
      return {
        at: row.at,
        id: str(row.raw.id) === undefined ? null : safeKey(row.raw.id),
        kind: row.kind,
        triggers: row.triggers,
        totalChars: row.totalChars,
        noticesChars,
        situationChars: noticeOf(row, 'situation') ?? null,
        humanActionsChars: num(row.raw.humanActionsChars) ?? null,
        freshMemoryChars: num(row.raw.freshMemoryChars) ?? null,
        bodyChars: num(row.raw.bodyChars) ?? null,
        framingChars: num(row.raw.framingChars) ?? null,
        attachments: num(row.raw.attachments) ?? null,
      };
    });

  return {
    state: 'read',
    rows: rows.length,
    unreadableRows: unreadable,
    total,
    byKind: groupDist(rows, (r) => [r.kind]),
    byBundle: groupDist(rows, (r) => [r.triggers.length === 0 ? '(取れない)' : [...new Set(r.triggers)].sort().join('+')]),
    bySingleTrigger: groupDist(rows, (r) => (r.triggers.length === 0 ? ['(取れない)'] : r.triggers)),
    occupancy: {
      totalCharsSum,
      situation,
      notices: orderedNoticeKeys.map((key) => ({ key, ...shareRow(rows, (r) => noticeOf(r, key)) })),
      humanActions: shareRow(rows, (r) => num(r.raw.humanActionsChars)),
      freshMemory: shareRow(rows, (r) => num(r.raw.freshMemoryChars)),
      body: shareRow(rows, (r) => num(r.raw.bodyChars)),
      framing: shareRow(rows, (r) => num(r.raw.framingChars)),
      bodyInside: {
        signals: insideShare(bodyInsideSignals),
        templates: insideShare(bodyInsideTemplates),
        framing: shareRow(rows, (r) => num(r.raw.framingChars)),
      },
    },
    situationParts: {
      turnsWithSituation,
      turnsWithParts,
      situationChars,
      parts: [...parts.entries()]
        .map(([key, values]) => {
          const dist = conversationDistOf(values);
          return {
            key,
            chars: dist.sum ?? 0,
            shareOfTotal: ratio(dist.sum ?? 0, totalCharsSum),
            shareOfSituation: ratio(dist.sum ?? 0, situationChars),
            perTurnMedian: dist.median,
          };
        })
        .sort((a, b) => b.chars - a.chars || a.key.localeCompare(b.key)),
    },
    templates: [...templateAcc.entries()]
      .map(([name, acc]) => {
        const length = TEMPLATES[name]?.length;
        return {
          name,
          turns: acc.turns,
          chars: acc.chars,
          shareOfTotal: ratio(acc.chars, totalCharsSum),
          occurrences: length === undefined || length === 0 ? null : Math.round(acc.chars / length),
          divisible: length === undefined || length === 0 ? null : acc.chars % length === 0,
        };
      })
      .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name)),
    signals: {
      byKind: [...signalAcc.entries()]
        .map(([kind, acc]) => ({
          kind,
          count: acc.count,
          chars: (BODYLESS_SIGNAL_KINDS as readonly string[]).includes(kind)
            ? null
            : conversationDistOf(acc.values),
          overLimit: acc.over,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      byManager: { limit: topN, totalManagers: managerRows.length, rows: managerRows.slice(0, topN) },
      omitted: { rows: omittedRows, total: omittedTotal },
      missingChars,
      overLimitTotal: [...signalAcc.values()].reduce((a, s) => a + s.over, 0),
    },
    redelivery: {
      turns: rows.length,
      withNotice: redeliveryTurns,
      share: redeliveryRead.rows.obtained === 0 ? null : ratio(redeliveryTurns, redeliveryRead.rows.obtained),
      rows: redeliveryRead.rows,
    },
    attachments: {
      sum: attachmentsRead.rows.obtained === 0 ? null : attachmentsRead.chars,
      rows: attachmentsRead.rows,
    },
    top,
  };
}

// ---- exchange（会話） ----

interface Classified {
  index: number;
  at: string;
  atMs: number;
  kind: ConversationKind;
  chars: number;
  body: string;
  managerId: string | null;
  tagId: string | null;
  attachments: number;
  rejected: number;
  otherKey?: string;
  basis: 'text-derived' | 'derived-from-order';
}

interface ExchangeRead {
  rows: Classified[];
  nonManager: number;
  notExchange: number;
  unreadable: number;
}

function classifyExchanges(parsed: ParsedJournal): ExchangeRead {
  type Pending = Omit<Classified, 'kind' | 'managerId' | 'basis'> & {
    kind: ConversationKind | 'clone_outbound';
    managerIdField: string | null;
  };
  const pending: Pending[] = [];
  let nonManager = 0;
  let notExchange = 0;
  let unreadable = 0;
  parsed.rows.forEach((row, index) => {
    if (row.type !== 'exchange') {
      notExchange += 1;
      return;
    }
    if (row.raw.with !== 'manager') {
      nonManager += 1;
      return;
    }
    const text = str(row.raw.text);
    if (text === undefined) {
      unreadable += 1;
      return;
    }
    const role = row.raw.role === 'inbound' || row.raw.role === 'outbound' ? row.raw.role : null;
    const c = classifyExchangeText(text, role);
    pending.push({
      index,
      at: row.at,
      atMs: row.atMs,
      kind: c.kind,
      chars: c.body.length,
      body: c.body,
      managerIdField: str(row.raw.managerId) === undefined ? null : safeKey(row.raw.managerId),
      tagId: c.tagId === null ? null : safeKey(c.tagId),
      attachments: Array.isArray(row.raw.attachments) ? row.raw.attachments.length : 0,
      rejected: Array.isArray(row.raw.rejectedAttachments) ? row.raw.rejectedAttachments.length : 0,
      ...(c.otherKey === undefined ? {} : { otherKey: c.otherKey }),
    });
  });
  pending.sort((a, b) => a.atMs - b.atMs || a.index - b.index);

  // text の `[id]` は鍵にしない（スキーマの注意）。managerId 欄を持つ行で見えた id と一致したときだけ、欄の無い行（Pool 行・停止）の持ち主として引く
  const knownIds = new Set(pending.flatMap((p) => (p.managerIdField === null ? [] : [p.managerIdField])));
  const seenAny = new Set<string>();
  const askPending = new Set<string>();
  const rows: Classified[] = pending.map((p) => {
    const managerId = p.managerIdField ?? (p.tagId !== null && knownIds.has(p.tagId) ? p.tagId : null);
    // 順序の判定の鍵は text の id（同じ委譲の流れを追うため。表示の持ち主には managerId を使う）
    const flowId = p.tagId ?? p.managerIdField;
    let kind: ConversationKind;
    let basis: Classified['basis'] = 'text-derived';
    if (p.kind === 'clone_outbound') {
      basis = 'derived-from-order';
      if (flowId !== null && askPending.has(flowId)) {
        kind = 'clone_answer';
        askPending.delete(flowId);
      } else if (flowId !== null && !seenAny.has(flowId)) {
        // 起動の依頼は、その委譲の最初の行。窓の途中から始まる日誌では、最初に見えた送信が追加指示のことがある
        kind = 'clone_request';
      } else kind = 'clone_followup';
    } else {
      kind = p.kind;
      if ((kind === 'question' || kind === 'permission') && flowId !== null) askPending.add(flowId);
    }
    if (flowId !== null) seenAny.add(flowId);
    return {
      index: p.index,
      at: p.at,
      atMs: p.atMs,
      kind,
      chars: p.chars,
      body: p.body,
      managerId,
      tagId: p.tagId,
      attachments: p.attachments,
      rejected: p.rejected,
      ...(p.otherKey === undefined ? {} : { otherKey: p.otherKey }),
      basis,
    };
  });
  return { rows, nonManager, notExchange, unreadable };
}

const MANAGER_NONE = '(managerId なし)';

function headOf(body: string, redact: (text: string) => string): string {
  // 全文へ伏せ字を掛けてから切る: 先に切ると鍵の断片が規則に当たらず残る
  const redacted = redact(body)
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '');
  return [...redacted].slice(0, EXCHANGE_HEAD_CHARS).join('');
}

function patternStats(items: TextIndicators[]): PatternStats {
  const sum = (f: (i: TextIndicators) => number): number => items.reduce((a, i) => a + f(i), 0);
  const chars = sum((i) => i.chars);
  const lines = sum((i) => i.lines);
  return {
    rows: items.length,
    rowsWithFence: items.filter((i) => i.hasFence).length,
    rowsWithPathLike: items.filter((i) => i.pathLikeLines > 0).length,
    rowsWithStack: items.filter((i) => i.stackLines > 0).length,
    rowsWithError: items.filter((i) => i.errorLines > 0).length,
    rowsWithToolResult: items.filter((i) => i.toolResultLines > 0).length,
    chars,
    lines,
    fenceCharShare: ratio(sum((i) => i.fenceChars), chars),
    pathLikeLineShare: ratio(sum((i) => i.pathLikeLines), lines),
    stackLineShare: ratio(sum((i) => i.stackLines), lines),
    errorLineShare: ratio(sum((i) => i.errorLines), lines),
    toolResultLineShare: ratio(sum((i) => i.toolResultLines), lines),
  };
}

const occurrencesOf = (text: string, needle: string): number =>
  needle === '' ? 0 : text.split(needle).length - 1;

/** 報告の本文から、注記と拒否の答え方の定型を除いた主文（パターンの測りに使う） */
function reportMainText(body: string): string {
  return splitReportNotes(body).main.split(DENIAL_REPLY_ROUTE).join('');
}

function exchangesSections(
  read: ExchangeRead,
  topN: number,
  redact: (text: string) => string,
): { exchanges: ExchangesSection; contamination: ContaminationSection } {
  const rows = read.rows;
  const byKindRows: ExchangeKindRow[] = CONVERSATION_KINDS.map((kind) => {
    const of = rows.filter((r) => r.kind === kind);
    return {
      kind,
      label: CONVERSATION_KIND_LABELS[kind],
      count: of.length,
      chars: conversationDistOf(of.map((r) => r.chars)),
      basis:
        kind === 'clone_request' || kind === 'clone_followup' || kind === 'clone_answer'
          ? 'derived-from-order'
          : 'text-derived',
    };
  });

  const otherMap = new Map<string, { count: number; chars: number }>();
  for (const r of rows.filter((x) => x.kind === 'other')) {
    const key = r.otherKey ?? '(不明)';
    const cell = otherMap.get(key) ?? { count: 0, chars: 0 };
    cell.count += 1;
    cell.chars += r.chars;
    otherMap.set(key, cell);
  }

  const delivery = rows.filter((r) => DELIVERY_KINDS.includes(r.kind));
  const deliveredChars = delivery.reduce((a, r) => a + r.chars, 0);

  // 委譲ごと
  const managerMap = new Map<string, Classified[]>();
  const noManager = { count: 0, chars: 0 };
  for (const r of rows) {
    if (r.managerId === null) {
      noManager.count += 1;
      noManager.chars += r.chars;
      continue;
    }
    const list = managerMap.get(r.managerId) ?? [];
    list.push(r);
    managerMap.set(r.managerId, list);
  }
  const managers = [...managerMap.entries()]
    .map(([managerId, list]) => ({
      managerId,
      total: conversationDistOf(list.map((r) => r.chars)),
      byKind: CONVERSATION_KINDS.flatMap((kind) => {
        const of = list.filter((r) => r.kind === kind);
        return of.length === 0 ? [] : [{ kind, count: of.length, chars: of.reduce((a, r) => a + r.chars, 0) }];
      }),
    }))
    .sort((a, b) => (b.total.sum ?? 0) - (a.total.sum ?? 0) || a.managerId.localeCompare(b.managerId));

  // 上位の大きい文面（先頭だけ。表示の直前に伏せ字）
  const topRows = [...rows]
    .sort((a, b) => b.chars - a.chars || a.atMs - b.atMs || a.index - b.index)
    .slice(0, topN)
    .map((r): ExchangeTopText => ({
      kind: r.kind,
      label: CONVERSATION_KIND_LABELS[r.kind],
      at: r.at,
      chars: r.chars,
      managerId: r.managerId,
      head: headOf(r.body, redact),
    }));

  // 本文に残る定型
  const denialRows = rows.filter((r) => r.kind === 'denial_notice');
  const denialOccurrences = delivery.reduce((a, r) => a + occurrencesOf(r.body, DENIAL_REPLY_ROUTE), 0);
  const denialChars = denialOccurrences * DENIAL_REPLY_ROUTE.length;
  const askRows = delivery.filter(
    (r) =>
      r.body.includes(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH) ||
      r.body.includes(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE),
  );
  const askChars = delivery.reduce(
    (a, r) =>
      a +
      occurrencesOf(r.body, DENIAL_ASK_AFTER_ANSWER_PARAGRAPH) * DENIAL_ASK_AFTER_ANSWER_PARAGRAPH.length +
      occurrencesOf(r.body, DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE) *
        DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE.length,
    0,
  );
  const noteAcc: Record<ReportNoteKey, { rows: number; chars: number }> = {
    fullText: { rows: 0, chars: 0 },
    withheld: { rows: 0, chars: 0 },
    synthesized: { rows: 0, chars: 0 },
  };
  for (const r of delivery.filter((x) => REPORT_FAMILY_KINDS.includes(x.kind))) {
    const { notes } = splitReportNotes(r.body);
    for (const key of Object.keys(notes) as ReportNoteKey[]) {
      if (notes[key] > 0) {
        noteAcc[key].rows += 1;
        noteAcc[key].chars += notes[key];
      }
    }
  }

  const exchanges: ExchangesSection = {
    state: 'read',
    byKind: byKindRows,
    otherBreakdown: [...otherMap.entries()]
      .map(([key, c]) => ({ key, ...c }))
      .sort((a, b) => b.chars - a.chars || a.key.localeCompare(b.key)),
    delivered: conversationDistOf(delivery.map((r) => r.chars)),
    byManager: {
      limit: topN,
      totalManagers: managers.length,
      withoutManagerId: noManager,
      rows: managers.slice(0, topN),
    },
    top: topRows,
    templatesInText: {
      deliveredChars,
      denialRoute: {
        rows: delivery.filter((r) => r.body.includes(DENIAL_REPLY_ROUTE)).length,
        occurrences: denialOccurrences,
        chars: denialChars,
        shareOfDelivered: ratio(denialChars, deliveredChars),
        shareOfDenialRows: ratio(
          denialChars,
          denialRows.reduce((a, r) => a + r.chars, 0),
        ),
      },
      denialAskAfterAnswer: {
        rows: askRows.length,
        chars: askChars,
        shareOfDelivered: ratio(askChars, deliveredChars),
      },
      notes: (Object.keys(noteAcc) as ReportNoteKey[]).map((key) => ({
        key,
        label: REPORT_NOTE_LABELS[key],
        rows: noteAcc[key].rows,
        chars: noteAcc[key].chars,
        shareOfDelivered: ratio(noteAcc[key].chars, deliveredChars),
      })),
    },
  };

  // ---- 作業途中の混入の目安 ----
  const reportFamily = rows.filter((r) => REPORT_FAMILY_KINDS.includes(r.kind));
  const poolFull = rows.filter((r) => r.kind === 'pool_full');
  // Pool 行 → 次の配達行（報告）を、同じ id の流れで1対1に結ぶ
  const queue = new Map<string, Classified[]>();
  const ratios: number[] = [];
  let paired = 0;
  let unpairedDelivery = 0;
  for (const r of [...rows].sort((a, b) => a.atMs - b.atMs || a.index - b.index)) {
    const key = r.managerId ?? r.tagId;
    if (key === null) continue;
    if (r.kind === 'pool_full') {
      const list = queue.get(key) ?? [];
      list.push(r);
      queue.set(key, list);
    } else if (REPORT_FAMILY_KINDS.includes(r.kind)) {
      const pool = queue.get(key)?.shift();
      if (pool === undefined) unpairedDelivery += 1;
      else {
        paired += 1;
        const q = ratio(r.chars, pool.chars);
        if (q !== null) ratios.push(q);
      }
    }
  }
  const unpairedPool = [...queue.values()].reduce((a, l) => a + l.length, 0);

  const withNote = reportFamily.flatMap((r) => {
    const n = fullTextCharsOfNote(r.body);
    return n === null ? [] : [{ n, main: splitReportNotes(r.body).main.length }];
  });
  const overLimitRows = reportFamily.filter(
    (r) => codePointLength(splitReportNotes(r.body).main) > MANAGER_REPORT_BODY_LIMIT,
  );

  // 依頼と報告の長さの比（委譲ごと）
  const requestChars = new Map<string, number>();
  const reportChars = new Map<string, number>();
  for (const r of rows) {
    if (r.managerId === null) continue;
    if (r.kind === 'clone_request') requestChars.set(r.managerId, (requestChars.get(r.managerId) ?? 0) + r.chars);
    if (REPORT_FAMILY_KINDS.includes(r.kind)) reportChars.set(r.managerId, (reportChars.get(r.managerId) ?? 0) + r.chars);
  }
  const both = [...requestChars.keys()].filter((id) => reportChars.has(id));
  const perDelegation = both.flatMap((id) => {
    const q = ratio(reportChars.get(id) ?? 0, requestChars.get(id) ?? 0);
    return q === null ? [] : [q];
  });
  const totalRequest = both.reduce((a, id) => a + (requestChars.get(id) ?? 0), 0);
  const totalReport = both.reduce((a, id) => a + (reportChars.get(id) ?? 0), 0);

  const contamination: ContaminationSection = {
    state: 'read',
    poolVsDelivery: {
      paired,
      unpairedPool,
      unpairedDelivery,
      ratio: conversationDistOf(ratios),
      fullTextNote: {
        reportRows: reportFamily.length,
        rowsWithNote: withNote.length,
        noteShare: ratio(withNote.length, reportFamily.length),
        fullChars: conversationDistOf(withNote.map((x) => x.n)),
        intermediateChars: conversationDistOf(withNote.map((x) => Math.max(0, x.n - x.main))),
        inconsistent: withNote.filter((x) => x.n < x.main).length,
      },
    },
    overLimit: {
      limit: MANAGER_REPORT_BODY_LIMIT,
      reportRows: reportFamily.length,
      rowsOverLimit: overLimitRows.length,
      share: ratio(overLimitRows.length, reportFamily.length),
      reportChars: conversationDistOf(reportFamily.map((r) => r.chars)),
    },
    patterns: {
      delivery: patternStats(reportFamily.map((r) => indicatorsOf(reportMainText(r.body)))),
      poolFull: patternStats(poolFull.map((r) => indicatorsOf(reportMainText(r.body)))),
    },
    attachments: {
      rowsWithAttachments: rows.filter((r) => r.attachments > 0).length,
      attachments: rows.reduce((a, r) => a + r.attachments, 0),
      rowsWithRejected: rows.filter((r) => r.rejected > 0).length,
    },
    requestVsReport: {
      delegations: both.length,
      totalRequestChars: both.length === 0 ? null : totalRequest,
      totalReportChars: both.length === 0 ? null : totalReport,
      overallRatio: ratio(totalReport, totalRequest),
      perDelegationRatio: conversationDistOf(perDelegation),
    },
  };
  return { exchanges, contamination };
}

// ---- 見積り（turn_input が無い所だけ） ----

const ESTIMATE_NOT_COVERED = [
  '質問・許可確認の末尾の案内（managerPrompt の中で字面に直書きされ、定数が無い）',
  '「いまの全体」の可変の行（委譲の本数・器・受信箱・鍵の行）。固定の2定数だけを数えた下限',
  'distillGap・contextWindowFold・droppedSignals・redelivery・validity・mergedBatchTruncation・commitment の注記、人間の操作の節、記憶の差分（文面が現在の状態から作られ、日誌に残らない）',
  '外部イベント・タイマー・自発・蒸留の合図の定型',
];

function estimateSection(
  journal: ParsedJournal,
  turns: TurnRow[],
  exchanges: ExchangeRead | null,
): EstimateSection {
  const constants = {
    situationHeadChars: SITUATION_HEAD.length,
    readingsNoticeChars: READINGS_NOTICE.length,
    reportFollowUpGuideChars: REPORT_FOLLOW_UP_GUIDE.length,
    originGuideChars: {
      min: Math.min(ORIGIN_NO_TASK_GUIDE.length, ORIGIN_TASK_GUIDE.length),
      max: Math.max(ORIGIN_NO_TASK_GUIDE.length, ORIGIN_TASK_GUIDE.length),
    },
  };
  const timing = journal.rows.filter((r) => r.type === 'turn_timing');
  if (timing.length === 0 && exchanges === null) {
    return {
      state: 'unavailable',
      reason: 'turn_timing も exchanges も無く、ターンの数も配達の数も取れない',
      constants,
      days: [],
      totals: { estimatedNormalTurns: 0, situationFixedChars: 0, reportGuideChars: null },
      notEstimated: ESTIMATE_NOT_COVERED,
    };
  }
  const days = new Set<string>();
  const timingNormal = new Map<string, number>();
  for (const row of timing) {
    const day = utcDay(row.atMs);
    days.add(day);
    // 通常のターンだけ数える: 蒸留のターンは「いまの全体」の注記を付けるか日誌から分からないので入れない（下限）
    if (Array.isArray(row.raw.kinds) && row.raw.kinds.includes('normal')) {
      timingNormal.set(day, (timingNormal.get(day) ?? 0) + 1);
    }
  }
  const measuredNormal = new Map<string, number>();
  const measuredAny = new Map<string, number>();
  const signalsReport = new Map<string, number>();
  for (const t of turns) {
    const day = utcDay(t.atMs);
    days.add(day);
    measuredAny.set(day, (measuredAny.get(day) ?? 0) + 1);
    if (t.kind === 'normal') measuredNormal.set(day, (measuredNormal.get(day) ?? 0) + 1);
    // 一覧の先頭 20 件より後の合図は kind が分からないので、省いた分も全部「報告だったかもしれない」として引く（二重に数えない側へ倒す）
    const signals = signalsOf(t) ?? [];
    const listed = signals.filter((s) => ['manager_report', 'denial_notice'].includes(safeKey(s.kind))).length;
    const omitted = num(t.raw.signalsOmitted) ?? 0;
    signalsReport.set(day, (signalsReport.get(day) ?? 0) + listed + omitted);
  }
  const deliveriesByDay = new Map<string, Classified[]>();
  if (exchanges !== null) {
    for (const r of exchanges.rows) {
      if (!REPORT_FAMILY_KINDS.includes(r.kind)) continue;
      const day = utcDay(r.atMs);
      days.add(day);
      const list = deliveriesByDay.get(day) ?? [];
      list.push(r);
      deliveriesByDay.set(day, list);
    }
  }

  const perTurnFixed = constants.situationHeadChars + constants.readingsNoticeChars;
  const out: EstimateDay[] = [];
  for (const day of [...days].sort()) {
    const tn = timingNormal.get(day) ?? 0;
    const mn = measuredNormal.get(day) ?? 0;
    const estNormal = Math.max(0, tn - mn);
    const delivered = deliveriesByDay.get(day) ?? [];
    const remainder =
      exchanges === null ? null : Math.max(0, delivered.length - (signalsReport.get(day) ?? 0));
    const guide =
      remainder === null
        ? null
        : {
            min: remainder * (constants.reportFollowUpGuideChars + constants.originGuideChars.min),
            max: remainder * (constants.reportFollowUpGuideChars + constants.originGuideChars.max),
          };
    const measuredTurns = measuredAny.get(day) ?? 0;
    const basis: EstimateDay['basis'] =
      measuredTurns === 0
        ? tn > 0 || delivered.length > 0
          ? 'estimated'
          : 'no-turns'
        : estNormal > 0 || (remainder ?? 0) > 0
          ? 'mixed'
          : 'measured';
    const body =
      basis === 'estimated' && exchanges !== null
        ? delivered.reduce((a, r) => {
            const { main, notes } = splitReportNotes(r.body);
            const tail = notes.fullText + notes.withheld + notes.synthesized;
            return a + Math.min(codePointLength(main), MANAGER_REPORT_BODY_LIMIT) + tail;
          }, 0)
        : null;
    const fixed = estNormal * perTurnFixed;
    const share =
      body === null || guide === null
        ? null
        : {
            min: (fixed + guide.min) / (fixed + guide.min + body),
            max: (fixed + guide.max) / (fixed + guide.max + body),
          };
    out.push({
      day,
      basis,
      timingNormalTurns: tn,
      measuredNormalTurns: mn,
      estimatedNormalTurns: estNormal,
      situationFixedChars: fixed,
      remainderReportDeliveries: remainder,
      reportGuideChars: guide,
      deliveryBodyChars: body,
      framingShare: share,
    });
  }
  const guideTotals = out.every((d) => d.reportGuideChars === null)
    ? null
    : {
        min: out.reduce((a, d) => a + (d.reportGuideChars?.min ?? 0), 0),
        max: out.reduce((a, d) => a + (d.reportGuideChars?.max ?? 0), 0),
      };
  return {
    state: 'read',
    reason: timing.length === 0 ? 'turn_timing が無く、見積りに回すターンの数が取れない（配達の案内だけ見積もる）' : null,
    constants,
    days: out,
    totals: {
      estimatedNormalTurns: out.reduce((a, d) => a + d.estimatedNormalTurns, 0),
      situationFixedChars: out.reduce((a, d) => a + d.situationFixedChars, 0),
      reportGuideChars: guideTotals,
    },
    notEstimated: ESTIMATE_NOT_COVERED,
  };
}

// ---- manifest / coverage ----

function manifestSummary(input: ConversationManifestInput): ConversationManifestSummary {
  const empty: ConversationManifestSummary = {
    state: 'none',
    reason: null,
    pulledAt: null,
    window: null,
    requestedExchanges: null,
    skippedNonManager: null,
    truncated: [],
    failures: [],
  };
  if (input.state !== 'read') return { ...empty, state: input.state, reason: input.reason };
  const m = input.value;
  if (!isObj(m)) return { ...empty, state: 'unreadable', reason: 'manifest.json がオブジェクトでない' };
  const window =
    isObj(m.window) && typeof m.window.since === 'string' && typeof m.window.until === 'string'
      ? { since: safeKey(m.window.since), until: safeKey(m.window.until) }
      : null;
  return {
    state: 'read',
    reason: null,
    pulledAt: str(m.pulledAt) === undefined ? null : safeKey(m.pulledAt),
    window,
    requestedExchanges: isObj(m.requested) && typeof m.requested.exchanges === 'boolean' ? m.requested.exchanges : null,
    skippedNonManager: num(m.skippedNonManager) ?? null,
    truncated: Array.isArray(m.truncated)
      ? m.truncated.filter(isObj).map((t) => ({
          part: safeKey(t.part),
          reason: safeKey(t.reason),
          limit: num(t.limit) ?? null,
          rows: num(t.rows) ?? null,
        }))
      : [],
    failures: Array.isArray(m.failures)
      ? m.failures.filter(isObj).map((f) => ({
          part: safeKey(f.part),
          status: num(f.status) ?? null,
          reason: safeKey(f.reason),
        }))
      : [],
  };
}

function coverageOf(
  input: AnalyzeConversationInput,
  turnRows: number,
  turnUnreadable: number,
  read: ExchangeRead | null,
  measured: MeasuredSection | null,
  redact: (text: string) => string,
): ConversationCoverage {
  const manifest = manifestSummary(input.manifest);
  // 失敗の理由は自由文なので、表示へ出す前に伏せ字を掛ける
  manifest.failures = manifest.failures.map((f) => ({ ...f, reason: redact(f.reason) }));
  const journal = {
    rows: input.journal.rows.length,
    turnInputRows: turnRows + turnUnreadable,
    turnTimingRows: input.journal.rows.filter((r) => r.type === 'turn_timing').length,
  };
  const warnings: string[] = [];
  for (const t of manifest.truncated) {
    warnings.push(
      `pull が上限で止まった（${t.part}: ${t.reason}${t.limit === null ? '' : ` 上限 ${t.limit}`}）。この分析はその部分が欠けている`,
    );
  }
  for (const f of manifest.failures) {
    warnings.push(`pull の取得に失敗した（${f.part}${f.status === null ? '' : ` status=${f.status}`}: ${f.reason}）。この部分は取れていない`);
  }
  if (manifest.requestedExchanges === false) {
    warnings.push('pull は --no-exchanges で取っている。会話（exchanges）の分析は出せない');
  }
  if (manifest.skippedNonManager !== null && manifest.skippedNonManager > 0) {
    warnings.push(
      `人間との会話の行 ${manifest.skippedNonManager} 行は pull が保存しないので、この分析には出ない（with が manager 以外）`,
    );
  }
  if (measured !== null && measured.signals.omitted.total > 0) {
    warnings.push(
      `turn_input の合図は先頭 20 件までしか持たない。取れなかった分（先頭 20 件より後）: ${measured.signals.omitted.total} 件（${measured.signals.omitted.rows} ターン）。合図ごと・委譲ごとの集計はその分だけ少ない`,
    );
  }
  if (turnUnreadable > 0) warnings.push(`totalChars が読めない turn_input 行 ${turnUnreadable} 行は集計に入れていない`);
  if (turnRows + turnUnreadable === 0) {
    warnings.push('turn_input の行が1つも無い。ターンの入力の内訳は実測できない（定型の注記は下の見積りだけ。実測ではない）');
  }
  if (read !== null && read.nonManager > 0) {
    warnings.push(`exchanges.jsonl に with が manager 以外の行が ${read.nonManager} 行あった。分析から除いた`);
  }

  const turnInputState = turnRows > 0 ? 'measured' : 'unavailable';
  const hasExchanges = read !== null;
  const axes: ConversationAxis[] = [
    {
      axis: 'ターンの入力の総量・内訳・占有率（notices・situationParts・framingChars・templates）',
      basis: turnInputState,
      source: 'journal の turn_input',
      note:
        turnRows > 0
          ? '実測（クローンへ実際に渡した文字列の長さ）。turn_input の無いターンは含まれない'
          : 'turn_input が無いので取れない（0 ではない）。下の見積りだけ',
    },
    {
      axis: '合図ごと・委譲ごとの大きさ（signals）',
      basis: turnInputState,
      source: 'journal の turn_input.signals',
      note: '実測。先頭 20 件まで。chars は 8000 字で切る前の長さ',
    },
    {
      axis: '会話の種類・件数・文字数・委譲ごと・上位の文面',
      basis: hasExchanges ? 'text-derived' : 'unavailable',
      source: 'exchanges.jsonl の本文（日誌の exchange）',
      note: hasExchanges
        ? '行の本文の字数。日誌の本文は注記を足す前の文字列で、クローンに実際に渡った最終の文面ではない'
        : 'exchanges.jsonl が無いので取れない（0 ではない）',
    },
    {
      axis: '本文に残る定型の占有（拒否の答え方・畳んだ報告の注記・全文の注記）',
      basis: hasExchanges ? 'text-derived' : 'unavailable',
      source: 'exchanges.jsonl の本文の字面を数えた',
      note: '日誌の本文に残る分だけ。プロンプト組み立て時に足される定型は含まない（下の見積り）',
    },
    {
      axis: '作業途中の混入の目安',
      basis: hasExchanges ? 'text-derived' : 'unavailable',
      source: 'exchanges.jsonl の本文の文字列検査',
      note: '本文を機械的に測っただけの目安で、合否の判定ではない。tool_result の専用の欄は無く、本文の検査である',
    },
    {
      axis: 'プロンプト組み立て時に足される定型の注記（「区分の読み方」・報告の案内など）',
      basis: 'estimate',
      source: '固定の定数の長さ × ターン数・配達数',
      note: '見積り（実測ではない）。turn_input のある日・ターンは実測に置き換え、残りだけを見積もる',
    },
    {
      axis: 'クローンに実際に渡した最終の文面そのもの',
      basis: 'unavailable',
      source: '日誌に残らない',
      note: '注記を足す前の本文だけが日誌に残る。最終の長さは turn_input.totalChars（実測）にだけある',
    },
    {
      axis: '質問・許可確認の末尾の案内の長さ',
      basis: 'unavailable',
      source: 'managerPrompt の字面（定数が無い）',
      note: '見積りにも入れていない（取れない）',
    },
  ];
  return {
    journal,
    exchanges:
      read === null
        ? {
            state: 'none',
            reason: input.exchanges.state === 'none' ? input.exchanges.reason : '入力が無い',
          }
        : {
            state: 'read',
            rows: read.rows.length,
            invalidLines: input.exchanges.state === 'read' ? input.exchanges.parsed.invalidLines : 0,
            notExchangeRows: read.notExchange,
            nonManagerRows: read.nonManager,
            unreadableRows: read.unreadable,
          },
    manifest,
    axes,
    warnings,
  };
}

// ---- 本体 ----

export function analyzeConversation(input: AnalyzeConversationInput): ConversationAnalysis {
  const turn = turnRowsOf(input.journal);
  const measured = turn.rows.length > 0 ? measuredSection(turn.rows, turn.unreadable, input.topN) : null;
  const read = input.exchanges.state === 'read' ? classifyExchanges(input.exchanges.parsed) : null;
  const sections = read === null ? null : exchangesSections(read, input.topN, input.redact);
  const inputMissing =
    input.exchanges.state === 'none' ? input.exchanges.reason : '入力が無い';
  return {
    coverage: coverageOf(input, turn.rows.length, turn.unreadable, read, measured, input.redact),
    measured:
      measured ?? {
        state: 'none',
        reason:
          'journal に turn_input の行が無い（旧版の期間、または export の型の指定に含まれていない）。取れない軸であり、0 ではない',
      },
    exchanges: sections?.exchanges ?? { state: 'none', reason: inputMissing },
    contamination: sections?.contamination ?? { state: 'none', reason: inputMissing },
    estimate: estimateSection(input.journal, turn.rows, read),
  };
}
