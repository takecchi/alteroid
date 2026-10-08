import { fingerprintOf } from './credentials.js';
import { codePointBoundary } from './excerpt.js';
import type { JournalEntryInput } from './schema.js';

// 新しい型を足さず exchange（with: 'self'）を使う: journalEntrySchema を広げると openapi.json の外向きの API 面が動くため
// with を 'human' にしない: GET /conversations/:id が会話として返し、内部ターンの入力が人間の画面に並ぶため
export type TurnInput =
  | { type: 'distill'; reason: 'conversation_end' | 'shutdown' | 'scheduled'; prompt: string }
  | { type: 'pre_compact_distill'; transcriptTail: string }
  | { type: 'human_answer'; approvalId: string; text: string }
  | {
      type: 'timer';
      kind: string;
      cause: 'schedule' | 'schedule_catchup' | 'manual';
      target?: string;
      request: boolean;
      digest: string;
    }
  | {
      type: 'self_initiative';
      reason: string;
      cause: 'schedule' | 'schedule_catchup' | 'manual';
      digest: string;
    }
  | {
      type: 'daily_report';
      date: string;
      cause: 'schedule' | 'schedule_catchup' | 'manual';
      digest: string;
    };

export function turnInputEntry(input: TurnInput): JournalEntryInput {
  return { type: 'exchange', with: 'self', role: 'inbound', text: describeTurnInput(input) };
}

const DIGEST_NOTE =
  '（本文は digest ＝この日誌・台帳・承認待ちの記録を寄せ直したものなので、ここへは写さない。' +
  '材料はそれぞれの器に在る）';

function describeTurnInput(input: TurnInput): string {
  switch (input.type) {
    case 'distill':
      return (
        `ターンの入力: distill reason=${tag(input.reason)} ${size(input.prompt, 'prompt')}` +
        '（本文は `buildDistillPrompt` の定型文で、この発火ごとに変わるものは reason だけである）'
      );
    // 指紋も残す: 材料が会話の生ログの末尾で、digest と違い器から組み直せないため
    case 'pre_compact_distill':
      return (
        `ターンの入力: pre_compact_distill ${size(input.transcriptTail, 'tail')} ` +
        `tail.fp=${fingerprintOf(input.transcriptTail)}` +
        '（本文は要約直前の会話ログの末尾で、任意の道具の出力を含みうる。' +
        '全文も抜粋も載せず、長さと指紋だけを残す）'
      );
    // 全文を写す: そのターンへ入った形は escalation の行からは組み直せないため
    case 'human_answer':
      return (
        `ターンの入力: human_answer approvalId=${tag(input.approvalId)}` +
        `（質問と人間の回答の全文。回答そのものは \`approvals_list\` でも取れる）\n\n${input.text}`
      );
    // 依頼の本文（request）は写さない: 器に在るので、渡したかどうかだけにする
    case 'timer':
      return (
        `ターンの入力: timer kind=${tag(input.kind)} cause=${tag(input.cause)}` +
        (input.target === undefined ? '' : ` target=${tag(input.target)}`) +
        ` request=${input.request ? 'yes' : 'no'} ${size(input.digest, 'digest')}${DIGEST_NOTE}`
      );
    case 'self_initiative':
      return (
        `ターンの入力: self_initiative reason=${tag(input.reason)} cause=${tag(input.cause)} ` +
        `${size(input.digest, 'digest')}${DIGEST_NOTE}`
      );
    case 'daily_report':
      return (
        `ターンの入力: daily_report date=${tag(input.date)} cause=${tag(input.cause)} ` +
        `${size(input.digest, 'digest')}${DIGEST_NOTE}`
      );
  }
}

// dropped-record.ts の TAG_LIMIT と共有しない: あちらは stderr の1行用で、切る理由が違うため
const TAG_LIMIT = 64;

function tag(value: string): string {
  const flat = value.replaceAll(/\s+/gu, ' ');
  return flat.length > TAG_LIMIT ? `${flat.slice(0, codePointBoundary(flat, TAG_LIMIT))}…` : flat;
}

function size(text: string, name: string): string {
  return `${name}.chars=${text.length}`;
}

export function composeTurnInputText(input: TurnInputText): string {
  return (
    input.distillGap +
    input.contextWindowFold +
    input.redelivery +
    input.superseded +
    input.validity +
    input.mergedBatchTruncation +
    input.commitment +
    input.situation +
    input.body
  );
}

// 欄を省略可にしない: 渡し忘れと今回は空が区別できず、断り書きが1本だけ静かに消えるため
export interface TurnInputText {
  readonly distillGap: string;
  readonly contextWindowFold: string;
  readonly redelivery: string;
  readonly superseded: string;
  readonly validity: string;
  readonly mergedBatchTruncation: string;
  readonly commitment: string;
  readonly situation: string;
  readonly body: string;
}
