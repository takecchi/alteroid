// `diagnostics analyze` の会話の分析が、日誌の `exchange` 行（`with: 'manager'`）の本文を種類へ分け、本文を機械的に測る部品。
// 読み取りのみ・通信なし。接頭辞と注記の字面は書き手の定数を import して使い、ここへ書き写さない（書き写すと書き手だけが直されて静かに外れる）。
// 日誌の行には `direction` / `kind` の欄が無い。種類は `text` の接頭辞（`exchange-kind.ts`）と `[managerId/kind]` の形で表されている。
import {
  MANAGER_REPORT_BODY_LIMIT,
  REPORT_FULL_TEXT_NOTE_MARK,
  REPORT_SYNTHESIZED_NOTE_MARK,
  REPORT_WITHHELD_NOTE_MARK,
} from './clone-batch-prompts.js';
import { DENIAL_REPLY_ROUTE } from './denial-key.js';
import { EXCHANGE_KIND_PREFIXES } from './exchange-kind.js';
import type { InboxEvent } from './schema.js';

export { MANAGER_REPORT_BODY_LIMIT };

type ManagerMessageKind = Extract<InboxEvent, { type: 'manager_message' }>['kind'];

/** 配達行の `[managerId/kind]` の kind。型で縛る（`schema.ts` の `manager_message.kind` が増えたら typecheck が落ちる） */
const DELIVERY_TAGS = [
  'report',
  'question',
  'permission',
] as const satisfies readonly ManagerMessageKind[];

/**
 * クローンの停止の行（`manager.ts` の停止の `#journal`）が `[managerId]` の後ろに置く語。
 * 定数が無く、`manager.ts` の呼び出しの字面に直書きされている。呼び出し側を定数へ置き換えると
 * `exchange-kind-coverage.test.ts` の走査と干渉しうるので、daemon 側は触らずここへ1か所だけ持つ。
 * `diagnostics-conversation-analysis.test.ts` が `manager.ts` の字面と一致していることを突き合わせる。
 */
export const EXCHANGE_STOP_MARK = '（停止）';

export const CONVERSATION_KINDS = [
  'report',
  'question',
  'permission',
  'denial_notice',
  'folded_bundle',
  'pool_full',
  'clone_request',
  'clone_followup',
  'clone_answer',
  'stop',
  'resume',
  'decision',
  'other',
] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_KIND_LABELS: Readonly<Record<ConversationKind, string>> = {
  report: '報告（配達行 [id/report]）',
  question: '質問（配達行 [id/question]）',
  permission: '許可確認（配達行 [id/permission]）',
  denial_notice: '拒否の知らせ（配達行の本文に拒否の答え方の定型）',
  folded_bundle: '束ねた知らせ（畳んだ報告の注記を含む配達行）',
  pool_full: 'Pool の全文行（[id]。途中の発言込み。クローンには渡らない）',
  clone_request: 'クローンの依頼（outbound の起動）',
  clone_followup: '追加指示（outbound）',
  clone_answer: '返事（質問・許可確認への outbound）',
  stop: '停止（outbound）',
  resume: '再開・復旧（[復旧]）',
  decision: '判断行（[判断]）',
  other: 'その他（分類できなかった行）',
};

/** クローンが実際に受け取る行（配達行）。Pool の全文行は同じ報告の控えなので含めない */
export const DELIVERY_KINDS: readonly ConversationKind[] = [
  'report',
  'question',
  'permission',
  'denial_notice',
  'folded_bundle',
];
/** 報告から来た配達行（8000 字の上限・末尾の注記・案内の対象） */
export const REPORT_FAMILY_KINDS: readonly ConversationKind[] = [
  'report',
  'denial_notice',
  'folded_bundle',
];

export interface ClassifiedExchangeText {
  /** `clone_outbound` は、依頼・追加指示・返事の3つ。順序の状態が要るので呼び手が決める */
  kind:
    | Exclude<ConversationKind, 'clone_request' | 'clone_followup' | 'clone_answer'>
    | 'clone_outbound';
  /** text の `[id]` / `[id/kind]` の id（欄ではない。呼び手は managerId 欄と突き合わせて使う）。無ければ null */
  tagId: string | null;
  /** 接頭辞と `[id…]` を除いた本文。認識できない行は text 全体 */
  body: string;
  /** `other` のときの内訳の鍵（本文の自由文は使わない） */
  otherKey?: string;
  deliveryTag?: ManagerMessageKind;
}

const TAG = /^\[([^\]/\s]+)(?:\/([^\]\s]+))?\] /;

/** 本文を種類へ分ける。`role` は日誌の行の欄。読めない行は null */
export function classifyExchangeText(
  text: string,
  role: 'inbound' | 'outbound' | null,
): ClassifiedExchangeText {
  const hit = EXCHANGE_KIND_PREFIXES.find((p) => text.startsWith(p.prefix));
  if (hit === undefined) return { kind: 'other', tagId: null, body: text, otherKey: '接頭辞なし' };
  const rest = text.slice(hit.prefix.length);
  const tag = TAG.exec(rest);
  const tagId = tag === null ? null : (tag[1] ?? null);
  const body = tag === null ? rest : rest.slice(tag[0].length);
  switch (hit.kind) {
    case 'decision':
      return { kind: 'decision', tagId, body };
    case 'recovery':
      return { kind: 'resume', tagId, body };
    case 'failure':
    case 'thinning':
    case 'gauge':
    case 'record':
      return { kind: 'other', tagId, body, otherKey: `${hit.kind} の接頭辞` };
    case 'reply':
      break;
  }
  if (tag === null || tagId === null) {
    return { kind: 'other', tagId: null, body, otherKey: '応答の接頭辞だが [id] が読めない' };
  }
  const subKind = tag[2];
  if (role === 'inbound' && subKind === undefined) return { kind: 'pool_full', tagId, body };
  if (role === 'inbound') {
    const deliveryTag = DELIVERY_TAGS.find((t) => t === subKind);
    if (deliveryTag === undefined) {
      return { kind: 'other', tagId, body, otherKey: '配達行の kind が未知' };
    }
    if (deliveryTag === 'question') return { kind: 'question', tagId, body, deliveryTag };
    if (deliveryTag === 'permission') return { kind: 'permission', tagId, body, deliveryTag };
    if (body.includes(DENIAL_REPLY_ROUTE))
      return { kind: 'denial_notice', tagId, body, deliveryTag };
    if (hasWithheldNote(body)) return { kind: 'folded_bundle', tagId, body, deliveryTag };
    return { kind: 'report', tagId, body, deliveryTag };
  }
  if (role === 'outbound' && subKind === undefined) {
    return body.startsWith(EXCHANGE_STOP_MARK)
      ? { kind: 'stop', tagId, body }
      : { kind: 'clone_outbound', tagId, body };
  }
  return { kind: 'other', tagId, body, otherKey: 'role と形が合わない応答' };
}

// ---- 本文の注記 ----

const NOTE_MARKS = [
  { key: 'fullText', mark: REPORT_FULL_TEXT_NOTE_MARK },
  { key: 'withheld', mark: REPORT_WITHHELD_NOTE_MARK },
  { key: 'synthesized', mark: REPORT_SYNTHESIZED_NOTE_MARK },
] as const;
export type ReportNoteKey = (typeof NOTE_MARKS)[number]['key'];

export const REPORT_NOTE_LABELS: Readonly<Record<ReportNoteKey, string>> = {
  fullText: '「途中の発言を含む全文 N 字は…」（reportDeliveryTextOf）',
  withheld: '畳んだ報告の注記（背景処理待ちで畳んだターンの報告を N 本配っていない…）',
  synthesized: '直前と同じ本文の「機構が合成した知らせ」を配っていない注記',
};

export function hasWithheldNote(body: string): boolean {
  return body.includes(REPORT_WITHHELD_NOTE_MARK);
}

/** 本文を、注記より前（主文）と注記ごとの字数へ分ける。`boundedReportBody`（clone-batch-prompts.ts）と同じ切り方（いちばん手前の目印から後ろを注記とみなす） */
export function splitReportNotes(body: string): {
  main: string;
  notes: Record<ReportNoteKey, number>;
} {
  const found = NOTE_MARKS.map(({ key, mark }) => ({ key, at: body.lastIndexOf(mark) })).filter(
    (x) => x.at !== -1,
  );
  const notes: Record<ReportNoteKey, number> = { fullText: 0, withheld: 0, synthesized: 0 };
  if (found.length === 0) return { main: body, notes };
  found.sort((a, b) => a.at - b.at);
  found.forEach((x, index) => {
    const end = found[index + 1]?.at ?? body.length;
    notes[x.key] = end - x.at;
  });
  return { main: body.slice(0, found[0]?.at ?? body.length), notes };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FULL_TEXT_NOTE_N = new RegExp(`${escapeRegExp(REPORT_FULL_TEXT_NOTE_MARK)}(\\d+) 字`);

/** 「途中の発言を含む全文 N 字」の N。注記が無い・読めなければ null */
export function fullTextCharsOfNote(body: string): number | null {
  const m = FULL_TEXT_NOTE_N.exec(body);
  return m === null ? null : Number(m[1]);
}

/** 字数はコードポイントで数える（`boundedReportBody` と同じ） */
export const codePointLength = (s: string): number => [...s].length;

// ---- 作業途中の混入の目安（文面を機械的に測るだけ。合否の判定ではない）----

/** コードブロックの囲み。行の先頭（空白を除く）がこれで始まる行を、囲みの開閉として数える */
export const CODE_FENCE = '```';
/** パス風の行: 行全体が `a/b/c` の形（先頭の `./` `../` `~/` `/` は可、`:行` `:行:列` の接尾は可）。区切りの `/` を1つ以上含む */
export const PATH_LIKE_LINE =
  /^\s*(?:[-*]\s+)?(?:\.{1,2}\/|~\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]*(?::\d+(?::\d+)?)?\s*$/;
/** スタックトレース風の行: 空白を除いて `at ` で始まり、続きがある行 */
export const STACK_TRACE_LINE = /^\s*at\s+\S/;
/** エラー風の行: `Error:` を含む行 */
export const ERROR_LINE = /Error:/;
/** `tool_result` 風の接頭辞: 行頭（`<` `[` 可）の `tool_result` / `tool_use`。本文の文字列検査であって、日誌に専用の欄は無い */
export const TOOL_RESULT_LIKE_LINE = /^\s*[<[]?tool_(?:result|use)\b/i;

export const CONTAMINATION_PATTERNS = [
  { key: 'codeFence', label: 'コードブロック（```）', source: CODE_FENCE },
  { key: 'pathLike', label: 'パス風の行', source: String(PATH_LIKE_LINE) },
  { key: 'stackTrace', label: 'スタックトレース風の行', source: String(STACK_TRACE_LINE) },
  { key: 'error', label: 'Error: を含む行', source: String(ERROR_LINE) },
  { key: 'toolResult', label: 'tool_result 風の接頭辞の行', source: String(TOOL_RESULT_LIKE_LINE) },
] as const;

export interface TextIndicators {
  chars: number;
  /** 空行を除いた行数 */
  lines: number;
  fenceChars: number;
  hasFence: boolean;
  pathLikeLines: number;
  stackLines: number;
  errorLines: number;
  toolResultLines: number;
}

export function indicatorsOf(text: string): TextIndicators {
  let inFence = false;
  let fenceChars = 0;
  let hasFence = false;
  let lines = 0;
  let pathLikeLines = 0;
  let stackLines = 0;
  let errorLines = 0;
  let toolResultLines = 0;
  for (const line of text.split('\n')) {
    const isFenceLine = line.trimStart().startsWith(CODE_FENCE);
    if (isFenceLine) {
      hasFence = true;
      inFence = !inFence;
      fenceChars += line.length + 1;
      continue;
    }
    if (inFence) fenceChars += line.length + 1;
    if (line.trim() === '') continue;
    lines += 1;
    if (PATH_LIKE_LINE.test(line)) pathLikeLines += 1;
    if (STACK_TRACE_LINE.test(line)) stackLines += 1;
    if (ERROR_LINE.test(line)) errorLines += 1;
    if (TOOL_RESULT_LIKE_LINE.test(line)) toolResultLines += 1;
  }
  return {
    chars: text.length,
    lines,
    fenceChars: Math.min(fenceChars, text.length),
    hasFence,
    pathLikeLines,
    stackLines,
    errorLines,
    toolResultLines,
  };
}
