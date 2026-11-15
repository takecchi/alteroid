import {
  BATCH_REPORT_FOLLOW_UP_GUIDE,
  ORIGIN_NO_TASK_GUIDE,
  ORIGIN_TASK_GUIDE,
  REPORT_FOLLOW_UP_GUIDE,
  payloadText,
} from './clone-batch-prompts.js';
import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { DENIAL_REPLY_ROUTE } from './denial-key.js';
import { EXTERNAL_EVENT_FRAMING, externalEventInstruction } from './prompt.js';
import { DAILY_REPORT_KIND } from './schedule.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
import type { TurnInputText } from './turn-input.js';

// クローンの1ターンに実際に渡した入力の組み立ての内訳を、日誌の1行（`turn_input`）にする。
// 数えるのは文字数・件数・識別子だけで、合図の本文も注記の文面も行へ写さない（この関数は文字列を受けても、長さと種類名しか返さない）。
// 入力の文字列は組み立てない・変えない: `#runTurn` が組んだ結果の長さを受け取って並べるだけ。

export type TurnInputEntry = Extract<JournalEntryInput, { type: 'turn_input' }>;

/** 1行に載せる合図の件数の上限。超えた分は `signalsOmitted` に件数だけ持つ（1ターン1行を肥大させない）。 */
export const TURN_INPUT_SIGNALS_LIMIT = 20;

/**
 * `composeTurnInputText` の欄のうち、本文以外（注記）。キーは欄名のまま（`commitment` は待ち行列の断り。欄名の由来は `TurnInputText.commitment`）。
 * 並びは `composeTurnInputText` の連結の並び。
 */
const NOTICE_KEYS = [
  'distillGap',
  'contextWindowFold',
  'droppedSignals',
  'redelivery',
  'validity',
  'mergedBatchTruncation',
  'commitment',
  'situation',
] as const satisfies readonly Exclude<keyof TurnInputText, 'body'>[];

/**
 * 本文（`#runTurn` の `text`）へ組み込まれる定型の注記。キーは定数の識別子名。
 * ビルダーの文字列は変えず、組み上がった本文の中の出現を数える（出現回数 × 定数の長さ）。
 */
const TEMPLATES: Readonly<Record<string, string>> = {
  REPORT_FOLLOW_UP_GUIDE,
  BATCH_REPORT_FOLLOW_UP_GUIDE,
  ORIGIN_NO_TASK_GUIDE,
  ORIGIN_TASK_GUIDE,
  DENIAL_REPLY_ROUTE,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
  EXTERNAL_EVENT_FRAMING,
  EXTERNAL_EVENT_INSTRUCTION: externalEventInstruction(),
};

/** 本文の中の定型ごとの文字数（出現が0のものは省く）。 */
export function countTemplateChars(body: string): Record<string, number> {
  const chars: Record<string, number> = {};
  for (const [name, template] of Object.entries(TEMPLATES)) {
    if (template === '') continue;
    const occurrences = body.split(template).length - 1;
    if (occurrences > 0) chars[name] = occurrences * template.length;
  }
  return chars;
}

interface SignalObservation {
  kind: string;
  managerId?: string;
  chars: number;
}

/**
 * 合図の区分。`manager_message` は種別で分け、拒否の知らせは定型（`DENIAL_REPLY_ROUTE`）を含む報告として見分ける
 * （診断の区分けのためだけで、ターンの入力の組み立てには使わない）。
 */
function signalKindOf(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return 'human';
    case 'human_answer':
      return 'human_answer';
    case 'distill':
      return 'distill';
    case 'timer':
      return event.kind === DAILY_REPORT_KIND ? 'daily_report' : 'timer';
    case 'external':
      return 'external';
    case 'self_initiative':
      return 'self_initiative';
    case 'manager_message':
      switch (event.kind) {
        case 'question':
          return 'manager_question';
        case 'permission':
          return 'manager_confirmation';
        case 'report':
          return event.text.includes(DENIAL_REPLY_ROUTE) ? 'denial_notice' : 'manager_report';
      }
  }
}

/**
 * 合図の元の本文の長さ（切る前）。イベントが本文を持たない種類（蒸留・タイマー・発意・日報）は、
 * 1件だけのターンなら本文そのもの（定型の文面）の長さ、束なら 0（取れない）にする。
 */
function signalCharsOf(event: InboxEvent, bodyChars: number, batchSize: number): number {
  switch (event.type) {
    case 'human_message':
      return event.text.length;
    case 'human_answer':
      return event.answer.length;
    case 'manager_message':
      return event.text.length;
    case 'external':
      return payloadText(event.payload, event.attachments).length;
    case 'distill':
    case 'timer':
    case 'self_initiative':
      return batchSize === 1 ? bodyChars : 0;
  }
}

function attachmentCountOf(event: InboxEvent): number {
  switch (event.type) {
    case 'human_message':
    case 'external':
    case 'manager_message':
      return event.attachments?.length ?? 0;
    default:
      return 0;
  }
}

export interface TurnInputObservation {
  kind: 'normal' | 'distill';
  conversationId: string | null;
  /** このターンの束（`turn_timing` の `triggers` と同じ出どころ）。 */
  batch: readonly InboxEvent[];
  /** `composeTurnInputText` へ渡した欄（本文を含む）。 */
  composed: TurnInputText;
  /** `composeTurnInputText` の出力・`withHumanActions` の出力・`withFreshMemory` の出力（実際に渡した入力）の長さ。 */
  lengths: { composed: number; withHumanActions: number; final: number };
  /** `notices.situation` の行ごとの長さ。組めなかった回は `undefined`。 */
  situationParts: Record<string, number> | undefined;
}

export function buildTurnInputEntry(observation: TurnInputObservation): TurnInputEntry {
  const { composed, lengths, batch } = observation;
  const bodyChars = composed.body.length;

  const notices: Record<string, number> = {};
  for (const key of NOTICE_KEYS) {
    if (composed[key].length > 0) notices[key] = composed[key].length;
  }

  const allSignals: SignalObservation[] = batch.map((event) => ({
    kind: signalKindOf(event),
    ...(event.type === 'manager_message' ? { managerId: event.managerId } : {}),
    chars: signalCharsOf(event, bodyChars, batch.length),
  }));
  const signals = allSignals.slice(0, TURN_INPUT_SIGNALS_LIMIT);
  const signalsOmitted = allSignals.length - signals.length;

  const templates = countTemplateChars(composed.body);
  const templateChars = Object.values(templates).reduce((sum, chars) => sum + chars, 0);
  const signalChars = allSignals.reduce((sum, signal) => sum + signal.chars, 0);

  return {
    type: 'turn_input',
    kind: observation.kind,
    ...(observation.conversationId === null ? {} : { conversationId: observation.conversationId }),
    triggers: [...new Set(batch.map((event) => event.type))],
    totalChars: lengths.final,
    bodyChars,
    humanActionsChars: Math.max(0, lengths.withHumanActions - lengths.composed),
    freshMemoryChars: Math.max(0, lengths.final - lengths.withHumanActions),
    notices,
    ...(observation.situationParts === undefined || notices.situation === undefined
      ? {}
      : { situationParts: observation.situationParts }),
    signals,
    ...(signalsOmitted > 0 ? { signalsOmitted } : {}),
    ...(Object.keys(templates).length === 0 ? {} : { templates }),
    framingChars: Math.max(0, bodyChars - signalChars - templateChars),
    attachments: batch.reduce((sum, event) => sum + attachmentCountOf(event), 0),
  };
}
