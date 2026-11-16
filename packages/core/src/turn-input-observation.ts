import {
  BATCH_REPORT_FOLLOW_UP_GUIDE,
  BATCH_REPORT_FOLLOW_UP_REF,
  ORIGIN_NO_TASK_GUIDE,
  ORIGIN_NO_TASK_REF,
  ORIGIN_TASK_GUIDE,
  ORIGIN_TASK_REF,
  REPORT_FOLLOW_UP_GUIDE,
  REPORT_FOLLOW_UP_REF,
  payloadText,
} from './clone-batch-prompts.js';
import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { DENIAL_REPLY_ROUTE } from './denial-key.js';
import {
  EXTERNAL_EVENT_FRAMING,
  EXTERNAL_EVENT_INSTRUCTION,
  externalEventInstruction,
} from './prompt.js';
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
export const NOTICE_KEYS = [
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
export const TEMPLATES: Readonly<Record<string, string>> = {
  // 全文の側は、いまの本文にはもう出ない（システムプロンプトへ移した）。残すのは、移す前の日誌の行が持つ名前から出現回数を割り戻すため（`diagnostics-conversation-analysis.ts` の `occurrences`）
  REPORT_FOLLOW_UP_GUIDE,
  BATCH_REPORT_FOLLOW_UP_GUIDE,
  ORIGIN_NO_TASK_GUIDE,
  ORIGIN_TASK_GUIDE,
  DENIAL_REPLY_ROUTE,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
  EXTERNAL_EVENT_FRAMING,
  EXTERNAL_EVENT_INSTRUCTION,
  // いまの本文に出る参照
  REPORT_FOLLOW_UP_REF,
  BATCH_REPORT_FOLLOW_UP_REF,
  ORIGIN_NO_TASK_REF,
  ORIGIN_TASK_REF,
  EXTERNAL_EVENT_INSTRUCTION_REF: externalEventInstruction(),
};

function occurrencesOf(text: string, template: string): number {
  return text.split(template).length - 1;
}

/**
 * 本文の中の定型ごとの文字数（出現が0のものは省く）。数えるのは合図の本文（`signalTexts`）の外にある出現だけ。
 * 合図の本文の中の出現を数えない理由: 拒否の知らせ・拒否の許可確認の固定文面（`DENIAL_*`）は `event.text` の一部で、
 * 既に `signals[].chars` に数えられている。ここでも数えると同じ字が2つの区分に入り、`framingChars`（本文 − 合図 − 定型）が過小になる。
 * 合図の側（`signals[].chars` は切る前の本文の長さ）を削る形にしない: 日誌の読み手が「合図の本文の長さ」として読んでいるため。
 */
export function countTemplateChars(
  body: string,
  signalTexts: readonly string[] = [],
): Record<string, number> {
  const chars: Record<string, number> = {};
  for (const [name, template] of Object.entries(TEMPLATES)) {
    if (template === '') continue;
    const insideSignals = signalTexts.reduce((sum, text) => sum + occurrencesOf(text, template), 0);
    // 切り詰めで合図の本文の側の出現が本文から消えた回は、本文の出現が合図の出現より少ない。負にせず 0 で止める
    const outside = Math.max(0, occurrencesOf(body, template) - insideSignals);
    if (outside > 0) chars[name] = outside * template.length;
  }
  return chars;
}

interface SignalObservation {
  kind: string;
  managerId?: string;
  chars: number;
  /** 本文に中身が出なかった合図だけ `false`。出た合図は欄を持たない（既存の行と同じ形）。 */
  rendered?: false;
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
 * 合図の元の本文（切る前）。長さは `signals[].chars`、中身は定型の二重計上を避けるために使う（`countTemplateChars`）。
 * イベントが本文を持たない種類（蒸留・タイマー・発意・日報）は、
 * 1件だけのターンなら本文そのもの（定型の文面）、束なら `undefined`（長さ 0・取れない）にする。
 */
function signalTextOf(event: InboxEvent, body: string, batchSize: number): string | undefined {
  switch (event.type) {
    case 'human_message':
      return event.text;
    case 'human_answer':
      return event.answer;
    case 'manager_message':
      return event.text;
    case 'external':
      return payloadText(event.payload, event.attachments);
    case 'distill':
    case 'timer':
    case 'self_initiative':
      return batchSize === 1 ? body : undefined;
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
  /**
   * 束の本文に中身が出なかった合図の id。束の本文を組む関数（`externalBatchUnrenderedIds`・`managerReportBatchRender`）が決めた値を受け取る。
   * ここで同一判定や予算の判定を再計算しない: 本文を組む側とずれるため。無ければ全件が本文に出たものとして数える。
   */
  unrenderedEventIds?: ReadonlySet<string>;
  /** `composeTurnInputText` へ渡した欄（本文を含む）。 */
  composed: TurnInputText;
  /** `composeTurnInputText` の出力・`withHumanActions` の出力・`withFreshMemory` の出力（実際に渡した入力）の長さ。 */
  lengths: { composed: number; withHumanActions: number; final: number };
  /** `notices.situation` の行ごとの長さ。組めなかった回は `undefined`。 */
  situationParts: Record<string, number> | undefined;
}

/** 本文（`composed.body`）の内訳の測り。合図と定型は、同じ字を2つの区分に数えない（`countTemplateChars`）。 */
function measureBody(observation: TurnInputObservation) {
  const { composed, batch } = observation;
  const body = composed.body;
  const signalTexts = batch.map((event) => signalTextOf(event, body, batch.length));
  const isRendered = (event: InboxEvent): boolean =>
    !(observation.unrenderedEventIds?.has(event.id) ?? false);
  const allSignals: SignalObservation[] = batch.map((event, index) => ({
    kind: signalKindOf(event),
    ...(event.type === 'manager_message' ? { managerId: event.managerId } : {}),
    chars: signalTexts[index]?.length ?? 0,
    ...(isRendered(event) ? {} : { rendered: false as const }),
  }));
  // 本文に出なかった合図は、本文の内訳（合図の本文の中の定型・合図の字数）から外す。`signals[].chars` には切る前の長さを残す
  const renderedTexts = batch.flatMap((event, index) => {
    const text = signalTexts[index];
    return text !== undefined && isRendered(event) ? [text] : [];
  });
  const templates = countTemplateChars(body, renderedTexts);
  const templateChars = Object.values(templates).reduce((sum, chars) => sum + chars, 0);
  const signalChars = allSignals.reduce(
    (sum, signal) => sum + (signal.rendered === false ? 0 : signal.chars),
    0,
  );
  return { bodyChars: body.length, allSignals, templates, templateChars, signalChars };
}

/**
 * 内訳（合図 + 定型）が本文を超えた字数。0 なら `framingChars` は丸めを経ていない。
 * 本番では切り詰め（長い報告の頭だけ・束の予算・外部イベントの上限）で、切る前の合図の長さが本文を超えるのが正常にありうる。
 * そのため `buildTurnInputEntry` は落とさず 0 に止める（観測は turn を落とさない）。丸めが起きない入力を作る試験は、これが 0 であることで二重計上を捕まえる。
 */
export function turnInputShortfallChars(observation: TurnInputObservation): number {
  const { bodyChars, signalChars, templateChars } = measureBody(observation);
  return Math.max(0, signalChars + templateChars - bodyChars);
}

export function buildTurnInputEntry(observation: TurnInputObservation): TurnInputEntry {
  const { composed, lengths, batch } = observation;
  const { bodyChars, allSignals, templates, templateChars, signalChars } = measureBody(observation);

  const notices: Record<string, number> = {};
  for (const key of NOTICE_KEYS) {
    if (composed[key].length > 0) notices[key] = composed[key].length;
  }

  const signals = allSignals.slice(0, TURN_INPUT_SIGNALS_LIMIT);
  const signalsOmitted = allSignals.length - signals.length;

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
