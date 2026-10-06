import { summarizeQuestions } from '@alteroid/core';

import type { DaemonClient } from './client.js';
import { withErrorReason } from './format.js';
import { redactBody, redactedErrorMessage } from './redact.js';

/**
 * 会話の読み返しに、その会話のターンから積まれた承認待ち（`ask_human`）を、時刻順の位置に
 * 1件1行で出す（#3261。Web は #3259 / #3271 で同じ承認を `createdAt` の位置に1枚のカードで出す）。
 *
 * **3か所（`alteroid conversations show`・REPL の `/conversation`・TUI の会話の開き直し）が
 * この1つを呼ぶ。** 別々に書くと、状態の言い方・伏せ字・取れなかったときの扱いが入口ごとにずれる。
 *
 * 取り方は既存の口 `GET /approvals?conversationId=<id>&pending=false&order=asc`（HTTP の形は変えない）。
 */

/** `GET /approvals` の1件のうち、この行が使う欄だけ。 */
export interface ConversationApproval {
  id: string;
  createdAt: string;
  question: string;
  questions?: Parameters<typeof summarizeQuestions>[0];
  answeredAt?: string | null;
  answer?: string | null;
  withdrawnAt?: string | null;
  withdrawnReason?: string | null;
}

/** 読めない承認待ちの行（壊れた行。回答済みでも取り下げ済みでもない）。 */
export interface ConversationApprovalUnreadable {
  id?: string;
  reason: string;
}

/**
 * 承認の取得結果。**取れなかったことを `approvals: []` に化けさせない**（「承認は無かった」と
 * 読めてしまう）ので、失敗は `failure` に理由を持つ。
 */
export interface ConversationApprovalsRead {
  approvals: ConversationApproval[];
  unreadable: ConversationApprovalUnreadable[];
  /** 取れなかった理由（伏せ字済み）。あれば `approvals` / `unreadable` は空。 */
  failure?: string;
}

/** 会話の発言と承認を、時刻順に並べた1要素。 */
export type TimelineItem<M> =
  { kind: 'message'; message: M } | { kind: 'approval'; approval: ConversationApproval };

/** 承認の取得を会話の表示から切り離す。失敗しても投げない（取れている発言まで奪わない）。 */
export async function fetchConversationApprovals(
  client: DaemonClient,
  conversationId: string,
): Promise<ConversationApprovalsRead> {
  try {
    const response = await client.approvals.$get({
      query: { conversationId, pending: 'false', order: 'asc' },
    });
    if (!response.ok) {
      return {
        approvals: [],
        unreadable: [],
        failure: redactedErrorMessage(
          new Error(
            await withErrorReason(
              `承認待ちを読めませんでした（HTTP ${String(response.status)}）`,
              response,
            ),
          ),
        ),
      };
    }
    const body: Partial<Awaited<ReturnType<typeof response.json>>> = await response.json();
    if (!Array.isArray(body.approvals)) {
      // 形の違う応答を「承認は無かった」に化けさせない。
      return { approvals: [], unreadable: [], failure: '応答の形が想定と違う' };
    }
    return {
      approvals: body.approvals as ConversationApproval[],
      unreadable: (body.unreadable ?? []) as ConversationApprovalUnreadable[],
    };
  } catch (error) {
    return { approvals: [], unreadable: [], failure: redactedErrorMessage(error) };
  }
}

function at(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * 発言（`at`）と承認（`createdAt`）を時刻順に1本へ並べる。**同時刻なら発言が先**（安定）。
 * 承認は積まれた時刻の位置だけに置く。回答の時刻は行の中に書く。⟹ 回答のあとのクローンの返答
 * （回答より後の時刻の発言）は、承認の行の後ろに来る。
 */
export function interleaveApprovals<M extends { at: string }>(
  messages: readonly M[],
  approvals: readonly ConversationApproval[],
): TimelineItem<M>[] {
  const sorted = [...approvals].sort((a, b) => at(a.createdAt) - at(b.createdAt));
  const items: TimelineItem<M>[] = [];
  let next = 0;
  for (const message of messages) {
    while (next < sorted.length && at(sorted[next]!.createdAt) < at(message.at)) {
      items.push({ kind: 'approval', approval: sorted[next]! });
      next += 1;
    }
    items.push({ kind: 'message', message });
  }
  for (; next < sorted.length; next += 1) items.push({ kind: 'approval', approval: sorted[next]! });
  return items;
}

function oneLine(value: string, max: number): string {
  // 伏せ字を先に掛ける（切ってからだとトークンの途中で切れて形が崩れ、取りこぼす）。
  const single = redactBody(value).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/**
 * 承認1件の1行。
 *
 * `? [時刻] 確認（承認待ち <id 先頭8字>）: <質問の要約> → 未回答 / 回答済み（時刻）: <回答> / 取り下げ（時刻）: <理由>`
 *
 * 取り下げは回答済みと別の終端で、両方立っていたら取り下げを優先する（Web の `ApprovalAnswerCard` と同じ）。
 * 行頭の `? ` を自分で付ける入口（TUI の 'ask' の行は行頭に `? ` を持つ）は {@link approvalText} を使う。
 */
export function approvalLine(approval: ConversationApproval): string {
  return `? ${approvalText(approval)}`;
}

/** {@link approvalLine} から行頭の `? ` を除いたもの。 */
export function approvalText(approval: ConversationApproval): string {
  const questions = approval.questions ?? [];
  const summary =
    oneLine(approval.question, 80) +
    (questions.length > 0 ? `（${summarizeQuestions(questions)}）` : '');
  const head = `[${approval.createdAt}] 確認（承認待ち ${approval.id.slice(0, 8)}）: ${summary}`;
  if (approval.withdrawnAt) {
    const reason = approval.withdrawnReason
      ? oneLine(approval.withdrawnReason, 120)
      : '（理由の記録なし）';
    return `${head} → 取り下げ（${approval.withdrawnAt}）: ${reason}`;
  }
  if (approval.answeredAt) {
    const answer = approval.answer ? oneLine(approval.answer, 120) : '（回答の記録なし）';
    return `${head} → 回答済み（${approval.answeredAt}）: ${answer}`;
  }
  return `${head} → 未回答`;
}

/**
 * 取れなかった・読めない行があることの断り（無ければ空配列）。
 * **「承認は無かった」と読めない言い方にする**（失敗を 0 件に化けさせない）。
 */
export function approvalNoticeLines(read: ConversationApprovalsRead): string[] {
  const lines: string[] = [];
  if (read.failure !== undefined) {
    lines.push(
      `（この会話の承認待ちは取れませんでした: ${read.failure}。承認が無かったのではありません）`,
    );
  }
  if (read.unreadable.length > 0) {
    const ids = read.unreadable
      .map((entry) => entry.id)
      .filter((id): id is string => id !== undefined);
    lines.push(
      `（読めない承認待ちが ${read.unreadable.length} 件あります${ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`}。` +
        '壊れた行であって、回答済み・取り下げ済みではありません。この会話の id が書かれている行だけを数えています' +
        '（会話の id すら読めない行と、ほかの会話の壊れた行はここに出ません。承認の画面で全件見られます）',
    );
  }
  return lines;
}
