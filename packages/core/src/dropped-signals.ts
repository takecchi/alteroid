import { codePointBoundary } from './excerpt.js';
import type { InboxEvent } from './schema.js';

/**
 * 枠以外の理由で失敗したターンに渡したまま、処理されずに受信箱から外れた合図の要旨（#4633 の案C）。
 * 配り直しはしない: 失敗したターンを同じ材料で焼き直す形になり、決定的に失敗する合図ではターンを焼き続けるため。
 * 代わりに次の通常ターンの入力へ要旨を添え、拾い直すかはクローンが判断する。
 */
export interface DroppedSignalDigest {
  readonly id: string;
  readonly at: string;
  readonly type: InboxEvent['type'];
  /** 誰から（会話・担当・外部の出どころ）。 */
  readonly from: string;
  /** 本文の冒頭（{@link DROPPED_SIGNAL_HEAD_CHARS} 字まで）。 */
  readonly head: string;
  readonly requestId?: string;
}

/** 本文の冒頭を何字まで添えるか。合図の見分けがつく長さで、全文は日誌・台帳から読み直せる。 */
export const DROPPED_SIGNAL_HEAD_CHARS = 200;

/** 次のターンへ添える要旨の上限（件）。超えた分は件数だけ言う。 */
export const DROPPED_SIGNAL_NOTICE_MAX = 20;

function head(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length > DROPPED_SIGNAL_HEAD_CHARS
    ? `${flat.slice(0, codePointBoundary(flat, DROPPED_SIGNAL_HEAD_CHARS))}…`
    : flat;
}

function payloadHead(payload: unknown): string {
  if (payload === undefined) return '';
  if (typeof payload === 'string') return head(payload);
  try {
    return head(JSON.stringify(payload) ?? '');
  } catch {
    return '（直列化できない中身）';
  }
}

/**
 * 外れた合図の要旨を作る。人間の回答（`human_answer`）は別の経路（配達の印を `pending` へ戻す。#4634）で戻すので載せない。
 * 蒸留（`distill`）は内部の合図で、次の区切りでまた起きるので載せない。
 */
export function digestOfDroppedSignal(event: InboxEvent): DroppedSignalDigest | null {
  const base = { id: event.id, at: event.at, type: event.type };
  switch (event.type) {
    case 'human_answer':
    case 'distill':
      return null;
    case 'human_message':
      return { ...base, from: `人間（会話 ${event.conversationId}）`, head: head(event.text) };
    case 'manager_message':
      return {
        ...base,
        from: `担当 ${event.managerId}（${event.kind}）`,
        head: head(event.text),
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      };
    case 'external':
      return { ...base, from: `外部 ${event.source}`, head: payloadHead(event.payload) };
    case 'timer':
      return {
        ...base,
        from: `時計 ${event.kind}`,
        head: event.target === undefined ? '' : `target=${event.target}`,
      };
    case 'self_initiative':
      return { ...base, from: '自発', head: head(event.reason) };
  }
}

function describeOne(digest: DroppedSignalDigest): string {
  const request = digest.requestId === undefined ? '' : ` requestId=${digest.requestId}`;
  const text = digest.head === '' ? '' : `: 「${digest.head}」`;
  return `- ${digest.at} ${digest.type} ${digest.from} id=${digest.id}${request}${text}`;
}

/**
 * 次の通常ターンの入力の頭に添える断り書き。拾い直す口の名前は書くが、「読め」とは書かない: 拾い直すかはクローンの判断のため。
 * `overflowed` は上限を超えて要旨を落とした件数。
 */
export function describeDroppedSignals(
  digests: readonly DroppedSignalDigest[],
  overflowed: number,
): string {
  if (digests.length === 0 && overflowed === 0) return '';
  return (
    '[system] 前のターンが枠以外の理由で失敗したので、そのターンに渡した次の合図は、' +
    '処理されないまま受信箱から外れた（配り直されない）。要旨を添える。' +
    '拾い直すか（人間の発言は `conversation_read`、担当の報告は `manager_report`、' +
    'その他は `journal_read` で読み直せる。相手に聞き直してもよい）は判断すること（#4633）。\n' +
    digests.map(describeOne).join('\n') +
    (overflowed > 0
      ? `\n（ほかに ${String(overflowed)} 件。日誌の「処理されないまま受信箱から外した」の行で見られる）`
      : '') +
    '\n\n---\n\n'
  );
}

/** 日誌に残す1行。次のターンに添える前に器が入れ替わっても、外れたことが残るようにする。 */
export function describeDroppedSignalsForJournal(
  digests: readonly DroppedSignalDigest[],
  reason: string,
): string {
  return (
    `ターンが枠以外の理由で失敗したので、渡した合図 ${String(digests.length)} 件を処理されないまま受信箱から外した` +
    `（理由: ${reason}）。次の通常ターンの入力に要旨を添える（#4633）。\n` +
    digests.map(describeOne).join('\n')
  );
}
