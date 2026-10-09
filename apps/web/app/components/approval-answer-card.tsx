import { describeAnsweredVia } from '@alteroid/core/answered-via';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';

import {
  ApprovalCard,
  ErrorNote,
  type ApprovalQuestionsAnswer,
  type ApprovalQuestionsDraft,
} from '@alteroid/ui';
import { useAnswerApproval } from '@alteroid/swr';
import { formatDateTime, summarizeQuestions } from '@alteroid/logic';
import type { PendingApproval } from '@alteroid/logic';

export function isApprovalAnswered(approval: PendingApproval): boolean {
  return approval.answeredAt !== undefined && approval.answeredAt !== null;
}

/** 両方 true の行が来たら取り下げを優先する。 */
export function isApprovalWithdrawn(approval: PendingApproval): boolean {
  return approval.withdrawnAt !== undefined && approval.withdrawnAt !== null;
}

/** 日付なしの入口を返す。回答済み詳細の日付はデーモンの `localDate()` で決まり id だけでは組めないので、入口が正しい日へ replace で移す。 */
export function approvalDetailPath(approvalId: string): string {
  return `/approvals/item/${encodeURIComponent(approvalId)}`;
}

export interface SentApprovalDraft {
  text: string;
  questions?: ApprovalQuestionsDraft;
}

export function ApprovalAnswerCard({
  approval,
  draft,
  onDraftChange,
  questionsDraft,
  onQuestionsDraftChange,
  onAnswered,
  onFailed,
  hideFailureWhenSettled = false,
  bulkError,
  bulkBusy = false,
  onSendingChange,
  footer,
  trailing,
  showSettledAt = false,
}: {
  approval: PendingApproval;
  draft?: string;
  onDraftChange?: (text: string) => void;
  questionsDraft?: ApprovalQuestionsDraft;
  onQuestionsDraftChange?: (draft: ApprovalQuestionsDraft) => void;
  /** `sent`（実際に送ったもの）と同じときだけ親は畳む。応答を待つ間に打ち足した分を消さないため。 */
  onAnswered?: (sent: SentApprovalDraft) => void;
  onFailed?: (error: unknown) => void;
  hideFailureWhenSettled?: boolean;
  bulkError?: string;
  bulkBusy?: boolean;
  onSendingChange?: (sending: boolean) => void;
  footer?: ReactNode;
  trailing?: ReactNode;
  showSettledAt?: boolean;
}) {
  const answerApproval = useAnswerApproval();
  const now = useMinuteNow();
  const [busy, setBusy] = useState(false);
  // state は次の描画まで古いので、同じ描画の中の2回目の押下は ref で止める。
  const sendingRef = useRef(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [ownDraft, setOwnDraft] = useState('');
  const currentDraft = draft ?? ownDraft;
  const changeDraft = onDraftChange ?? setOwnDraft;

  const answered = isApprovalAnswered(approval);
  const withdrawn = isApprovalWithdrawn(approval);
  const state = withdrawn ? 'withdrawn' : answered ? 'answered' : 'unanswered';

  async function send(request: () => Promise<void>, sent: SentApprovalDraft) {
    // 送信中（このカード・まとめ送信）は何もしない: 同じ承認を二重に送らない。
    if (sendingRef.current || bulkBusy) return;
    sendingRef.current = true;
    onSendingChange?.(true);
    setBusy(true);
    setFailure(undefined);
    try {
      await request();
      onAnswered?.(sent);
    } catch (caught) {
      setFailure(caught);
      onFailed?.(caught);
    } finally {
      sendingRef.current = false;
      setBusy(false);
      onSendingChange?.(false);
    }
  }

  async function submit(text: string) {
    if (text.trim() === '') return;
    await send(() => answerApproval(approval.id, text), { text, questions: undefined });
  }

  async function submitQuestions({ selections, supplement }: ApprovalQuestionsAnswer) {
    if (selections.length === 0 && supplement === undefined) return;
    await send(
      () =>
        answerApproval(approval.id, supplement, selections.length === 0 ? undefined : selections),
      { text: '', questions: questionsDraft },
    );
  }

  const hasFailure =
    failure !== undefined &&
    failure !== null &&
    !(hideFailureWhenSettled && state !== 'unanswered');
  const errors =
    hasFailure || bulkError !== undefined ? (
      <>
        <ErrorNote error={hasFailure ? failure : undefined} />
        {bulkError !== undefined && (
          <ErrorNote
            error={`まとめて送った回答は通らなかった: ${bulkError}`}
            className={hasFailure ? 'mt-2' : undefined}
          />
        )}
      </>
    ) : undefined;

  return (
    <ApprovalCard
      state={state}
      time={
        <>
          <span>{formatDateTime(approval.createdAt)}</span>
          <span>({formatRelativeAtMinute(approval.createdAt, now)})</span>
          {showSettledAt && state === 'answered' && approval.answeredAt != null && (
            <span>回答: {formatDateTime(approval.answeredAt)}</span>
          )}
          {showSettledAt && state === 'withdrawn' && approval.withdrawnAt != null && (
            <span>取り下げ: {formatDateTime(approval.withdrawnAt)}</span>
          )}
        </>
      }
      jobLink={
        approval.jobId !== undefined && approval.jobId !== null ? (
          <>
            {'委譲: '}
            <Link to={`/managers/${approval.jobId}`} className="hover:underline">
              詳細を見る
            </Link>
          </>
        ) : undefined
      }
      question={approval.question}
      context={approval.context ?? undefined}
      answer={approval.answer ?? undefined}
      /* 記録が無い古い行では渡さない（「わからない」を「operator ではない」に化けさせない）。 */
      answeredVia={approval.answeredVia ? describeAnsweredVia(approval.answeredVia) : undefined}
      withdrawnReason={approval.withdrawnReason ?? undefined}
      draft={currentDraft}
      onDraftChange={changeDraft}
      onSubmit={(text) => void submit(text)}
      questions={approval.questions ?? undefined}
      questionsSummary={
        approval.questions && approval.questions.length > 0
          ? summarizeQuestions(approval.questions)
          : undefined
      }
      onSubmitQuestions={(answer) => void submitQuestions(answer)}
      {...(questionsDraft === undefined || onQuestionsDraftChange === undefined
        ? {}
        : { questionsDraft, onQuestionsDraftChange })}
      busy={busy || bulkBusy}
      footer={footer}
      error={errors}
      trailing={trailing}
    />
  );
}
