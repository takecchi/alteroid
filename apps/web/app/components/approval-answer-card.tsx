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

/**
 * 承認待ち1件の「状態の導出・回答の送信・エラー表示」を持つカード。
 *
 * **承認の画面（`routes/approvals.tsx`）と会話の画面（`routes/chat.tsx`）の両方が使う**
 * （#3259）。別々に書くと、回答の送り方・取り下げの扱いが画面ごとにずれる。
 * 画面ごとに違うもの（回答済みの経緯・会話パネル・詳細への導線）は `footer` / `trailing` で渡す。
 */

export function isApprovalAnswered(approval: PendingApproval): boolean {
  return approval.answeredAt !== undefined && approval.answeredAt !== null;
}

/**
 * クローンが `approval_withdraw` で取り下げたか（issue #963）。
 * `isApprovalAnswered` と排他的な想定。両方 true の行が来たら取り下げを優先する。
 */
export function isApprovalWithdrawn(approval: PendingApproval): boolean {
  return approval.withdrawnAt !== undefined && approval.withdrawnAt !== null;
}

/**
 * 承認1件の詳細へ行く先。**リンクを作る箇所はここ1つにまとめてある。**
 *
 * 日付なしの入口（`/approvals/item/:id`。`routes/approvals-item.tsx`）を返す。回答済みの詳細
 * （`/approvals/answered/:date/:id`）の日付はデーモンの `localDate()` で決まり、id だけでは組めない
 * ので、入口が正しい日（未回答なら `/approvals`）へ replace で移す。
 */
export function approvalDetailPath(approvalId: string): string {
  return `/approvals/item/${encodeURIComponent(approvalId)}`;
}

/** 実際に送ったもの（`onAnswered` へ渡す）。送っていない欄は空（`text: ''`・`questions` 無し）。 */
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
  bulkError,
  bulkBusy = false,
  onSendingChange,
  footer,
  trailing,
  showSettledAt = false,
}: {
  approval: PendingApproval;
  /** 下書き。親が持つときだけ渡す（まとめ送信のため）。渡さなければカードの中で持つ。 */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** 設問のフォームの書きかけ。親が持つときだけ渡す（会話の画面。会話を移っても残す）。 */
  questionsDraft?: ApprovalQuestionsDraft;
  onQuestionsDraftChange?: (draft: ApprovalQuestionsDraft) => void;
  /**
   * この id に答えが通った。**実際に送ったもの**（`sent`）を渡す。呼ぶ側は、いまの下書きが
   * これと同じときだけ畳む（応答を待つ間に打ち足した分を消さない。issue #3515）。
   */
  onAnswered?: (sent: SentApprovalDraft) => void;
  /** 直前のまとめ送信でこの id が駄目だった理由（無ければ何も出さない）。 */
  bulkError?: string;
  /**
   * まとめ送信の最中か（#3626）。最中は、このカードの送信（ボタン・⌘/Ctrl+Enter）を止める。
   * 省略すれば止めない（会話の画面は渡さない）。
   */
  bulkBusy?: boolean;
  /**
   * このカードが送信中かが変わった（#3626）。親が「まとめて送る」の対象から外す・
   * 保存先の下書きを送信中に落とさないために使う。省略できる。
   */
  onSendingChange?: (sending: boolean) => void;
  /** 回答済みのときの経緯などを置く口。 */
  footer?: ReactNode;
  trailing?: ReactNode;
  /** 回答・取り下げの時刻もカードの上段に出す（会話の画面）。 */
  showSettledAt?: boolean;
}) {
  const answerApproval = useAnswerApproval();
  // 「たった今」「N分前」を古いまま残さない（#3596）。
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

  /**
   * `sent` は**実際に送ったもの**。成功したあとの「いまの下書き」ではなく、これと比べさせる。
   * 送っていない欄（定型の答えのときの回答欄、設問で答えたときの自由記述）は、控えに含めない。
   */
  async function send(request: () => Promise<void>, sent: SentApprovalDraft) {
    // 送信中（このカード・まとめ送信）は何もしない。同じ承認を二重に送らない（#3626）。
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

  /** 設問のフォームの「回答」（issue #2525）。畳んだ文はサーバが作る。 */
  async function submitQuestions({ selections, supplement }: ApprovalQuestionsAnswer) {
    if (selections.length === 0 && supplement === undefined) return;
    await send(
      () =>
        answerApproval(approval.id, supplement, selections.length === 0 ? undefined : selections),
      { text: '', questions: questionsDraft },
    );
  }

  const hasFailure = failure !== undefined && failure !== null;
  const errors =
    hasFailure || bulkError !== undefined ? (
      <>
        <ErrorNote error={failure} />
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
      /*
        `jobId` はマネージャー id（`pendingApprovalSchema` の doc）。委譲の詳細へつなぐ（issue #2041）。
      */
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
      /*
        回答経路（Issue #1479）。記録が無い古い行では渡さない（「わからない」を
        「operator ではない」に化けさせない）。
      */
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
