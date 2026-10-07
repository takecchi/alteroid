import { summarizeQuestions } from '@alteroid/core';
import { codePointBoundary } from '@alteroid/core/cli-light';

import type { DaemonClient } from './client.js';
import { withErrorReason } from './format.js';
import { redactBody, redactedErrorMessage } from './redact.js';

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

export interface ConversationApprovalUnreadable {
  id?: string;
  reason: string;
}

export interface ConversationApprovalsRead {
  approvals: ConversationApproval[];
  unreadable: ConversationApprovalUnreadable[];
  // 失敗を `approvals: []` にしない: 「承認は無かった」と読めてしまうため
  failure?: string;
}

export type TimelineItem<M> =
  { kind: 'message'; message: M } | { kind: 'approval'; approval: ConversationApproval };

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
  // 切ってから伏せ字にしない: トークンの途中で切れて形が崩れ、取りこぼすため
  const single = redactBody(value).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, codePointBoundary(single, max))}…` : single;
}

export function approvalLine(approval: ConversationApproval): string {
  return `? ${approvalText(approval)}`;
}

export function approvalText(approval: ConversationApproval): string {
  const questions = approval.questions ?? [];
  const summary =
    oneLine(approval.question, 80) +
    (questions.length > 0 ? `（${summarizeQuestions(questions)}）` : '');
  const head = `[${approval.createdAt}] 確認（承認待ち ${approval.id.slice(0, 8)}）: ${summary}`;
  // 取り下げを先に見る: 回答済みと両方立っていたら取り下げを優先するため
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
